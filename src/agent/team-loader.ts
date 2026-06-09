/**
 * TeamLoader: reads and validates .champ/teams/*.yaml team definitions.
 *
 * Validation rules:
 *   - Must have non-empty name, description, and agents array
 *   - Agent IDs must be unique within the team
 *   - dependsOn references must resolve to defined agent IDs
 *   - No circular dependencies (detected via Kahn's algorithm)
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as yaml from "js-yaml";
import type {
  TeamDefinition,
  TeamAgentDefinition,
  TeamExecutionConfig,
  TeamDefaults,
} from "./team-definition";

const VALID_TOOLS = new Set([
  "read_file",
  "edit_file",
  "create_file",
  "delete_file",
  "list_directory",
  "grep_search",
  "file_search",
  "run_terminal_cmd",
  "codebase_search",
  "generate_doc",
  "generate_diagram",
]);

const DEFAULT_EXECUTION: TeamExecutionConfig = {
  maxParallel: 3,
  totalTokenBudget: 100_000,
  timeoutSeconds: 120,
  retries: 1,
  checkpoints: true,
  mode: "auto",
};

export class TeamLoader {
  constructor(private readonly workspaceRoot: string) {}

  /** Load all team definitions from .champ/teams/. Returns [] if directory absent. */
  async loadAll(): Promise<TeamDefinition[]> {
    const dir = path.join(this.workspaceRoot, ".champ", "teams");
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const teams: TeamDefinition[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const filePath = path.join(dir, entry);
      // Path traversal guard
      if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep))
        continue;
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        teams.push(this.parseYaml(raw, filePath));
      } catch (err) {
        console.warn(`Champ TeamLoader: skipping "${entry}":`, err);
      }
    }
    return teams;
  }

  /** Parse and validate a team YAML string. Throws with a human-readable message on error. */
  parseYaml(raw: string, sourcePath: string): TeamDefinition {
    const doc = yaml.load(raw) as Record<string, unknown>;
    if (!doc || typeof doc !== "object") {
      throw new Error("Team YAML must be a mapping object");
    }

    const name = String(doc.name ?? "").trim();
    if (!name) throw new Error("Team must have a non-empty 'name' field");

    const description = String(doc.description ?? "").trim();
    if (!description)
      throw new Error("Team must have a non-empty 'description' field");

    if (!Array.isArray(doc.agents) || doc.agents.length === 0) {
      throw new Error("Team must have a non-empty 'agents' array");
    }

    const rawAgents = doc.agents as Record<string, unknown>[];
    const ids = new Set<string>();
    const agents: Required<TeamAgentDefinition>[] = rawAgents.map((a, i) => {
      if (!a || typeof a !== "object") {
        throw new Error(
          `Agent at index ${i} must be a mapping object, got ${JSON.stringify(a)}`,
        );
      }

      const id = String(a.id ?? "").trim();
      if (!id)
        throw new Error(`Agent at index ${i} is missing required 'id' field`);
      if (ids.has(id))
        throw new Error(`Duplicate agent ID "${id}" in team "${name}"`);
      ids.add(id);

      const agentName = String(a.name ?? id).trim();
      const role = String(a.role ?? "").trim();
      if (!role)
        throw new Error(`Agent "${id}" is missing required 'role' field`);
      const systemPrompt = String(a.systemPrompt ?? "").trim();
      if (!systemPrompt)
        throw new Error(
          `Agent "${id}" is missing required 'systemPrompt' field`,
        );

      const dependsOn = Array.isArray(a.dependsOn)
        ? [...new Set((a.dependsOn as string[]).map(String))]
        : [];
      const tools = Array.isArray(a.tools)
        ? (a.tools as string[]).map(String)
        : [];

      // Validate tool names
      for (const t of tools) {
        if (!VALID_TOOLS.has(t)) {
          throw new Error(
            `Agent "${id}" references unknown tool "${t}". Valid tools: ${[...VALID_TOOLS].join(", ")}`,
          );
        }
      }

      const outputFormat = (a.outputFormat as string) ?? "text";
      if (!["text", "json", "files"].includes(outputFormat)) {
        throw new Error(
          `Agent "${id}" outputFormat must be "text", "json", or "files"`,
        );
      }

      const subscribes: string[] = Array.isArray(a.subscribes)
        ? (a.subscribes as unknown[]).map(String)
        : [];

      return {
        id,
        name: agentName,
        role,
        systemPrompt,
        dependsOn,
        condition: String(a.condition ?? "").trim() || "",
        tools,
        model: String(a.model ?? "").trim() || "",
        maxTokens: Number(a.maxTokens ?? 4096),
        outputKey: String(a.outputKey ?? id).trim(),
        outputFormat: outputFormat as "text" | "json" | "files",
        selfCritique: Boolean(a.selfCritique ?? false),
        selfCritiqueMinContextWindow: Number(
          a.selfCritiqueMinContextWindow ?? 32768,
        ),
        subscribes,
      };
    });

    // Validate dependsOn references
    for (const agent of agents) {
      for (const dep of agent.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error(
            `Agent "${agent.id}" depends on "${dep}" which is not defined in the team`,
          );
        }
      }
    }

    // Detect cycles via topological sort
    this.detectCycles(agents);

    // Parse execution config
    const execRaw = (doc.execution ?? {}) as Record<string, unknown>;
    const execution: TeamExecutionConfig = {
      maxParallel: Number(execRaw.maxParallel ?? DEFAULT_EXECUTION.maxParallel),
      totalTokenBudget: Number(
        execRaw.totalTokenBudget ?? DEFAULT_EXECUTION.totalTokenBudget,
      ),
      timeoutSeconds: Number(
        execRaw.timeoutSeconds ?? DEFAULT_EXECUTION.timeoutSeconds,
      ),
      retries: Number(execRaw.retries ?? DEFAULT_EXECUTION.retries),
      checkpoints: Boolean(
        execRaw.checkpoints ?? DEFAULT_EXECUTION.checkpoints,
      ),
      mode:
        (execRaw.mode as "auto" | "safe" | "supervised") ??
        DEFAULT_EXECUTION.mode,
      maxDynamicAgents:
        execRaw.maxDynamicAgents != null
          ? Number(execRaw.maxDynamicAgents)
          : undefined,
    };

    // Validate execution.mode
    const VALID_EXEC_MODES_SET = new Set(["auto", "safe", "supervised"]);
    if (
      execRaw.mode !== undefined &&
      !VALID_EXEC_MODES_SET.has(String(execRaw.mode))
    ) {
      throw new Error(
        `execution.mode "${execRaw.mode}" is not valid. Must be "auto", "safe", or "supervised".`,
      );
    }

    const defaultsRaw = (doc.defaults ?? {}) as Record<string, unknown>;
    const defaults: TeamDefaults = {
      model: String(defaultsRaw.model ?? "").trim() || undefined,
      maxTokens:
        defaultsRaw.maxTokens != null
          ? Number(defaultsRaw.maxTokens)
          : undefined,
      temperature:
        defaultsRaw.temperature != null
          ? Number(defaultsRaw.temperature)
          : undefined,
    };

    return {
      name,
      description,
      version: String(doc.version ?? "1"),
      agents,
      execution,
      defaults,
      sourcePath,
    };
  }

  /** Kahn's algorithm cycle detection — throws if a cycle exists. */
  private detectCycles(agents: Required<TeamAgentDefinition>[]): void {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const a of agents) {
      inDegree.set(a.id, 0);
      adj.set(a.id, []);
    }
    for (const a of agents) {
      for (const dep of a.dependsOn) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }
    const queue = [...inDegree.entries()]
      .filter(([, d]) => d === 0)
      .map(([id]) => id);
    let processed = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      processed++;
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }
    if (processed !== agents.length) {
      const cycleNodes = [...inDegree.entries()]
        .filter(([, d]) => d > 0)
        .map(([id]) => id)
        .join(", ");
      throw new Error(
        `Dependency cycle detected among agents: ${cycleNodes}. Check dependsOn fields.`,
      );
    }
  }
}
