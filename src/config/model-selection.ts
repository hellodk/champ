/**
 * Shared task-based model selection across CLI and VS Code extension.
 *
 * Unifies explicit overrides, workspace `.champ/provider.json`, registry task
 * assignments, `routingMode` (`auto` vs `manual`), capability/context matching,
 * and endpoint fallbacks into a single authority.
 */
import * as fs from "fs";
import * as path from "path";
import { catalogEntry } from "./provider-catalog";
import type {
  DiscoveredModel,
  Endpoint,
  ProvidersDocument,
  TaskAssignment,
  WorkspaceProviderRef,
} from "./provider-model";
import type { EndpointRepository } from "./provider-repository";

export type SelectionTask =
  | "default"
  | "coding"
  | "chat"
  | "completion"
  | "embedding"
  | "review";

export interface SelectionRoutingRule {
  match: string;
  provider: string;
  model: string;
}

export interface ModelSelectionInput {
  task: SelectionTask;
  workspaceDir?: string;
  requiredCapabilities?: string[];
  contextTokens?: number;
  preferredEndpoint?: string;
  preferredModel?: string;
  currentFile?: string;
  routingRules?: SelectionRoutingRule[];
}

export interface ResolvedModelSelection {
  endpoint: Endpoint;
  model: string;
  task: SelectionTask;
  source:
    | "override"
    | "workspace"
    | "assignment"
    | "rule"
    | "smart"
    | "default-endpoint"
    | "first-enabled";
  reason: string;
  fallbacks: Endpoint[];
  /** Authoritative routing mode, derived from the registry document. */
  routingMode: "manual" | "auto";
}

/**
 * Read non-secret workspace endpoint/model overrides from `<workspace>/.champ/provider.json`.
 */
export function readWorkspaceProviderRef(
  workspace: string,
  warn?: (msg: string) => void,
): WorkspaceProviderRef | null {
  const refPath = path.join(workspace, ".champ", "provider.json");
  if (!fs.existsSync(refPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(refPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if ("apiKey" in obj) {
      warn?.(
        "[champ] ignoring embedded apiKey in .champ/provider.json (workspace refs cannot contain secrets)",
      );
    }
    const ref: WorkspaceProviderRef = {};
    if (typeof obj.endpoint === "string" && obj.endpoint.trim()) {
      ref.endpoint = obj.endpoint.trim();
    }
    if (typeof obj.model === "string" && obj.model.trim()) {
      ref.model = obj.model.trim();
    }
    if (
      obj.taskModels &&
      typeof obj.taskModels === "object" &&
      !Array.isArray(obj.taskModels)
    ) {
      ref.taskModels = obj.taskModels as WorkspaceProviderRef["taskModels"];
    }
    return ref;
  } catch (err) {
    warn?.(
      `[champ] ignoring invalid .champ/provider.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function toTaskAssignment(task: SelectionTask): TaskAssignment {
  return task === "review" ? "coding" : task;
}

function resolveModelName(ep: Endpoint, explicitModel?: string): string {
  const trimmed = explicitModel?.trim();
  if (trimmed) return trimmed;
  if (ep.models[0]?.id) return ep.models[0].id;
  const entry = catalogEntry(ep.provider);
  return entry.defaultModel ?? "default";
}

function matchGlob(pattern: string, filePath: string): boolean {
  if (pattern.startsWith("*.")) {
    return filePath.endsWith(pattern.slice(1));
  }
  return pattern === filePath;
}

function modelMatchesRequirements(
  ep: Endpoint,
  model: DiscoveredModel,
  input: ModelSelectionInput,
): boolean {
  const reqs = input.requiredCapabilities ?? [];
  for (const cap of reqs) {
    if (cap === "tools" || cap === "tool_calling") {
      const supportsTools =
        ep.supportsTools ?? catalogEntry(ep.provider).supportsTools;
      const modelHasTools =
        model.capabilities?.includes("tools") ||
        model.capabilities?.includes("tool_calling") ||
        model.capabilities?.includes("coding");
      if (!supportsTools && !modelHasTools) return false;
      continue;
    }
    if (!model.capabilities?.includes(cap)) return false;
  }
  if (input.contextTokens !== undefined) {
    const win = model.contextWindow ?? ep.contextWindow;
    if (win !== undefined && win < input.contextTokens) return false;
  }
  return true;
}

function scoreModelForTask(
  ep: Endpoint,
  model: DiscoveredModel,
  task: SelectionTask,
): number {
  let score = ep.isDefault ? 10 : 0;
  const caps = new Set(model.capabilities ?? []);
  const idLower = model.id.toLowerCase();

  if (task === "embedding") {
    if (caps.has("embedding") || /embed|bge-|e5-|nomic/i.test(idLower)) {
      score += 100;
    } else {
      return -1;
    }
  } else if (caps.has("embedding")) {
    return -1;
  }

  if (task === "coding" || task === "review") {
    if (caps.has("coding") || /coder|code|claude|gpt|qwen3/i.test(idLower)) {
      score += 40;
    }
    if (ep.supportsTools ?? catalogEntry(ep.provider).supportsTools) {
      score += 15;
    }
  } else if (task === "completion") {
    if (/1\.5b|3b|mini|flash|haiku|completion/i.test(idLower)) {
      score += 35;
    }
  } else if (task === "chat") {
    if (caps.has("general") || caps.has("instruct")) {
      score += 20;
    }
  }

  const win = model.contextWindow ?? ep.contextWindow ?? 0;
  if (win >= 32768) score += 10;
  return score;
}

export class ModelSelectionService {
  constructor(
    private readonly repository: EndpointRepository,
    private readonly warn?: (msg: string) => void,
  ) {}

  async resolve(
    input: ModelSelectionInput,
  ): Promise<ResolvedModelSelection | null> {
    const doc = await this.repository.read();
    return this.resolveFromDocument(doc, input);
  }

  /**
   * Resolve a model and expose the effective routing mode. Callers must use
   * this result as the single source of truth — they must not re-read
   * `doc.routingMode` and make a second, divergent routing decision.
   */
  resolveFromDocument(
    doc: ProvidersDocument,
    input: ModelSelectionInput,
  ): ResolvedModelSelection | null {
    const resolved = this.resolveInternal(doc, input);
    if (!resolved) return null;
    return {
      ...resolved,
      routingMode: doc.routingMode === "manual" ? "manual" : "auto",
    };
  }

  private resolveInternal(
    doc: ProvidersDocument,
    input: ModelSelectionInput,
  ): Omit<ResolvedModelSelection, "routingMode"> | null {
    const enabled = doc.endpoints.filter((ep) => ep.enabled);
    if (enabled.length === 0) return null;

    const byId = new Map(enabled.map((ep) => [ep.id, ep]));
    const taskKey = toTaskAssignment(input.task);
    const fallbacksFor = (chosen: Endpoint) =>
      enabled.filter((ep) => ep.id !== chosen.id);

    // 1. Explicit preferred endpoint
    if (input.preferredEndpoint) {
      const needle = input.preferredEndpoint.toLowerCase();
      const ep = enabled.find(
        (item) =>
          item.id === input.preferredEndpoint ||
          item.name.toLowerCase() === needle ||
          item.provider.toLowerCase() === needle,
      );
      if (ep) {
        return {
          endpoint: ep,
          model: resolveModelName(ep, input.preferredModel),
          task: input.task,
          source: "override",
          reason: `preferred endpoint (${ep.name})`,
          fallbacks: fallbacksFor(ep),
        };
      }
    }

    // 2. Workspace `.champ/provider.json`
    const wsRef = input.workspaceDir
      ? readWorkspaceProviderRef(input.workspaceDir, this.warn)
      : null;
    if (wsRef?.endpoint) {
      const match = enabled.find(
        (ep) =>
          ep.id === wsRef.endpoint ||
          ep.name.toLowerCase() === wsRef.endpoint!.toLowerCase(),
      );
      if (!match) {
        this.warn?.(
          `[champ] workspace provider.json references missing or disabled endpoint "${wsRef.endpoint}" — falling back to user registry`,
        );
      } else {
        const defaultResolved = doc.assignments[taskKey];
        const fallbackModel =
          defaultResolved?.endpointId === match.id
            ? defaultResolved.model
            : undefined;
        return {
          endpoint: match,
          model: resolveModelName(
            match,
            input.preferredModel ??
              wsRef.taskModels?.[taskKey] ??
              wsRef.model ??
              fallbackModel,
          ),
          task: input.task,
          source: "workspace",
          reason: "workspace .champ/provider.json",
          fallbacks: fallbacksFor(match),
        };
      }
    }

    // 3. Explicit task assignment in providers.json
    const taskAssign = doc.assignments[taskKey];
    if (taskAssign) {
      const ep = byId.get(taskAssign.endpointId);
      if (ep) {
        const candidateModel = ep.models.find(
          (m) => m.id === taskAssign.model,
        ) ?? { id: taskAssign.model };
        if (modelMatchesRequirements(ep, candidateModel, input)) {
          return {
            endpoint: ep,
            model: resolveModelName(
              ep,
              input.preferredModel ?? taskAssign.model,
            ),
            task: input.task,
            source: "assignment",
            reason: `task assignment (${taskKey})`,
            fallbacks: fallbacksFor(ep),
          };
        }
      }
    }

    // 4. Auto routing rules & capability/context matching when routingMode === "auto"
    if (doc.routingMode === "auto") {
      for (const rule of input.routingRules ?? []) {
        if (
          rule.match === input.task ||
          (input.currentFile && matchGlob(rule.match, input.currentFile))
        ) {
          const ep = enabled.find(
            (item) =>
              item.provider === rule.provider ||
              item.name.toLowerCase() === rule.provider.toLowerCase() ||
              item.id === rule.provider,
          );
          if (ep) {
            return {
              endpoint: ep,
              model: resolveModelName(ep, input.preferredModel ?? rule.model),
              task: input.task,
              source: "rule",
              reason: `routing rule (${rule.match})`,
              fallbacks: fallbacksFor(ep),
            };
          }
        }
      }

      if (input.task !== "default") {
        let best: {
          ep: Endpoint;
          model: DiscoveredModel;
          score: number;
        } | null = null;
        for (const ep of enabled) {
          for (const model of ep.models) {
            if (!modelMatchesRequirements(ep, model, input)) continue;
            const score = scoreModelForTask(ep, model, input.task);
            if (score >= 0 && (!best || score > best.score)) {
              best = { ep, model, score };
            }
          }
        }
        if (best) {
          return {
            endpoint: best.ep,
            model: resolveModelName(
              best.ep,
              input.preferredModel ?? best.model.id,
            ),
            task: input.task,
            source: "smart",
            reason: `auto capability match for ${input.task}`,
            fallbacks: fallbacksFor(best.ep),
          };
        }
      }
    }

    // 5. Default assignment
    const defaultAssign = doc.assignments.default;
    if (defaultAssign) {
      const ep = byId.get(defaultAssign.endpointId);
      if (ep) {
        return {
          endpoint: ep,
          model: resolveModelName(
            ep,
            input.preferredModel ?? defaultAssign.model,
          ),
          task: input.task,
          source: "assignment",
          reason: "default assignment",
          fallbacks: fallbacksFor(ep),
        };
      }
    }

    // 6. Default endpoint flag
    const defaultEndpoint = enabled.find((ep) => ep.isDefault);
    if (defaultEndpoint) {
      return {
        endpoint: defaultEndpoint,
        model: resolveModelName(defaultEndpoint, input.preferredModel),
        task: input.task,
        source: "default-endpoint",
        reason: "default endpoint",
        fallbacks: fallbacksFor(defaultEndpoint),
      };
    }

    // 7. First enabled endpoint
    const first = enabled[0];
    return {
      endpoint: first,
      model: resolveModelName(first, input.preferredModel),
      task: input.task,
      source: "first-enabled",
      reason: "first enabled endpoint",
      fallbacks: fallbacksFor(first),
    };
  }
}
