/**
 * SmartRouter: auto-discover models from all providers, classify them
 * by capability, and select the best model per task type.
 *
 * Performance: discovery runs in the background with parallel fetches
 * and a 3-second per-provider timeout. Selection is a pure in-memory
 * array scan (<0.1ms). Zero network calls in the hot path.
 */
import type { LLMProvider } from "./types";

export type TaskType = "coding" | "chat" | "completion" | "embedding";
export type ModelCapability = "coding" | "general" | "embedding" | "instruct";
export type ModelSpeed = "fast" | "medium" | "slow";

export interface DiscoveredModel {
  id: string;
  providerName: string;
  providerType: string;
  capabilities: ModelCapability[];
  speed: ModelSpeed;
  contextWindow: number;
  sizeHint: string;
}

export interface RouteResult {
  model: DiscoveredModel;
  provider: LLMProvider;
  reason: string;
}

interface ProviderEntry {
  provider: LLMProvider;
  type: string;
  baseUrl?: string;
}

const DISCOVERY_TIMEOUT_MS = 2000;

export class SmartRouter {
  private models: DiscoveredModel[] = [];
  private providerMap = new Map<string, ProviderEntry>();
  private mode: "smart" | "manual" = "smart";
  private manualModelId: string | null = null;
  private taskOverrides = new Map<TaskType, string | null>();
  private listeners = new Set<() => void>();
  private discovered = false;
  private lastModelsSig = "";

  /**
   * Register a provider that can be scanned for models.
   */
  registerProvider(
    name: string,
    provider: LLMProvider,
    type: string,
    baseUrl?: string,
  ): void {
    this.providerMap.set(name, { provider, type, baseUrl });
  }

  /**
   * Discover models from all registered providers in parallel.
   * Non-blocking — call with `void`, don't await during activation.
   */
  async discover(): Promise<void> {
    const entries = Array.from(this.providerMap.entries());
    const results = await Promise.allSettled(
      entries.map(([name, entry]) => this.discoverFromProvider(name, entry)),
    );

    const allModels: DiscoveredModel[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allModels.push(...result.value);
      }
    }

    const wasDiscovered = this.discovered;
    this.models = allModels;
    this.discovered = true;

    const sig = allModels
      .map((m) => `${m.providerName}:${m.id}`)
      .sort()
      .join("|");
    // Always emit on first discovery (signals readiness); after that only
    // emit when the model list actually changes (prevents UI chatter).
    if (!wasDiscovered || sig !== this.lastModelsSig) {
      this.lastModelsSig = sig;
      this.emit();
    }

    if (allModels.length > 0) {
      console.log(
        `Champ SmartRouter: discovered ${allModels.length} model(s) from ${entries.length} provider(s)`,
      );
    }
  }

  /**
   * Select the best model for a given task. In manual mode, returns the
   * locked selection. In smart mode, scores all models and picks the best.
   */
  select(taskType: TaskType): RouteResult | null {
    // Per-task model override from routing config (routing.coding, etc.)
    if (this.taskOverrides.has(taskType)) {
      const override = this.taskOverrides.get(taskType);
      if (override !== null && override !== undefined) {
        const model = this.models.find((m) => m.id === override);
        if (model) {
          const entry = this.providerMap.get(model.providerName);
          if (entry) {
            return {
              model,
              provider: entry.provider,
              reason: `routing.${taskType} override`,
            };
          }
        }
      }
    }

    if (this.mode === "manual" && this.manualModelId) {
      const model = this.models.find((m) => m.id === this.manualModelId);
      if (model) {
        const entry = this.providerMap.get(model.providerName);
        if (entry) {
          return {
            model,
            provider: entry.provider,
            reason: "manual selection",
          };
        }
      }
    }

    if (this.models.length === 0) return null;

    let best: DiscoveredModel | null = null;
    let bestScore = -Infinity;
    let bestReason = "";

    for (const model of this.models) {
      const s = score(model, taskType);
      if (s > bestScore) {
        bestScore = s;
        best = model;
        bestReason = `${taskType}: score ${s}`;
      }
    }

    if (!best) return null;

    const entry = this.providerMap.get(best.providerName);
    if (!entry) return null;

    return { model: best, provider: entry.provider, reason: bestReason };
  }

  getModels(): DiscoveredModel[] {
    return [...this.models];
  }

  isDiscovered(): boolean {
    return this.discovered;
  }

  setMode(mode: "smart" | "manual"): void {
    this.mode = mode;
  }

  getMode(): "smart" | "manual" {
    return this.mode;
  }

  setManualModel(modelId: string): void {
    this.manualModelId = modelId;
    this.mode = "manual";
  }

  resetToAuto(): void {
    this.mode = "smart";
    this.manualModelId = null;
  }

  /**
   * Override which model is used for a specific task type. Pass null to
   * revert to automatic selection. Used to wire the `routing:` YAML config.
   */
  setTaskModel(task: TaskType, modelId: string | null): void {
    this.taskOverrides.set(task, modelId);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * Discover models from a single provider with a timeout.
   */
  private async discoverFromProvider(
    name: string,
    entry: ProviderEntry,
  ): Promise<DiscoveredModel[]> {
    return Promise.race([
      this.fetchModels(name, entry),
      new Promise<DiscoveredModel[]>((resolve) =>
        setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS),
      ),
    ]);
  }

  private async fetchModels(
    name: string,
    entry: ProviderEntry,
  ): Promise<DiscoveredModel[]> {
    const results: DiscoveredModel[] = [];
    const baseUrl = (entry.baseUrl ?? "").replace(/\/+$/, "");
    if (!baseUrl) return results;

    // Try provider's listModels if available.
    if (
      "listModels" in entry.provider &&
      typeof (entry.provider as { listModels: () => Promise<unknown> })
        .listModels === "function"
    ) {
      try {
        const models = await (
          entry.provider as {
            listModels: () => Promise<Array<{ id: string; name: string }>>;
          }
        ).listModels();
        for (const m of models) {
          const classified = classify(m.name);
          results.push({
            id: m.name,
            providerName: name,
            providerType: entry.type,
            ...classified,
            contextWindow: entry.provider.modelInfo().contextWindow,
          });
        }
        if (results.length > 0) return results;
      } catch {
        /* fall through */
      }
    }

    // Fallback: try Ollama /api/tags
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{ name: string }>;
        };
        for (const m of data.models ?? []) {
          const classified = classify(m.name);
          results.push({
            id: m.name,
            providerName: name,
            providerType: entry.type,
            ...classified,
            contextWindow: 8192,
          });
        }
        if (results.length > 0) return results;
      }
    } catch {
      /* offline */
    }

    // Fallback: try /v1/models (OpenAI-compatible)
    try {
      const cleanBase = baseUrl.replace(/\/v1\/?$/, "");
      const res = await fetch(`${cleanBase}/v1/models`);
      if (res.ok) {
        const data = (await res.json()) as {
          data?: Array<{ id: string }>;
        };
        for (const m of data.data ?? []) {
          const classified = classify(m.id);
          results.push({
            id: m.id,
            providerName: name,
            providerType: entry.type,
            ...classified,
            contextWindow: 4096,
          });
        }
      }
    } catch {
      /* offline */
    }

    // Fallback: try /props (llama.cpp)
    if (results.length === 0) {
      try {
        const cleanBase = baseUrl.replace(/\/v1\/?$/, "");
        const res = await fetch(`${cleanBase}/props`);
        if (res.ok) {
          const data = (await res.json()) as {
            default_generation_settings?: {
              n_ctx?: number;
              model?: string;
            };
          };
          const modelName =
            data.default_generation_settings?.model ?? "default";
          const nCtx = data.default_generation_settings?.n_ctx ?? 4096;
          const classified = classify(modelName);
          results.push({
            id: modelName,
            providerName: name,
            providerType: entry.type,
            ...classified,
            contextWindow: nCtx,
          });
        }
      } catch {
        /* offline */
      }
    }

    return results;
  }
}

/**
 * Classify a model by name heuristics. Pure string matching, <1ms.
 */
function classify(name: string): {
  capabilities: ModelCapability[];
  speed: ModelSpeed;
  sizeHint: string;
} {
  const lower = name.toLowerCase();
  const capabilities: ModelCapability[] = [];

  if (
    /coder|code|starcoder|codestral|deepseek-coder|codellama|wizardcoder/.test(
      lower,
    )
  ) {
    capabilities.push("coding");
  }
  if (
    /embed|nomic|bge|e5-|gte|jina|minilm|all-mini|mxbai|voyage|rerank/.test(
      lower,
    )
  ) {
    capabilities.push("embedding");
  }
  if (/instruct|chat/.test(lower)) {
    capabilities.push("instruct");
  }
  if (capabilities.length === 0) {
    capabilities.push("general");
  }

  const sizeMatch = lower.match(/(\d+\.?\d*)b/);
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : 7;
  const sizeHint = sizeMatch ? `${sizeMatch[1]}B` : "unknown";

  let speed: ModelSpeed = "medium";
  if (sizeB <= 7) speed = "fast";
  else if (sizeB > 16) speed = "slow";

  return { capabilities, speed, sizeHint };
}

/**
 * Score a model for a given task type. Higher = better fit.
 */
function score(model: DiscoveredModel, taskType: TaskType): number {
  let s = 0;
  const sizeB = parseFloat(model.sizeHint) || 7;

  switch (taskType) {
    case "coding":
      if (model.capabilities.includes("coding")) s += 100;
      if (model.capabilities.includes("instruct")) s += 20;
      if (model.capabilities.includes("embedding")) s -= 999;
      s += sizeB * 2;
      break;

    case "chat":
      if (model.capabilities.includes("general")) s += 80;
      if (model.capabilities.includes("instruct")) s += 40;
      if (model.capabilities.includes("coding")) s += 20;
      if (model.capabilities.includes("embedding")) s -= 999;
      if (model.speed === "fast") s += 30;
      break;

    case "completion":
      if (model.capabilities.includes("embedding")) s -= 999;
      if (model.speed === "fast") s += 100;
      if (model.capabilities.includes("coding")) s += 50;
      s -= sizeB;
      break;

    case "embedding":
      if (model.capabilities.includes("embedding")) s += 200;
      else s -= 999;
      break;
  }

  s += Math.log2(model.contextWindow) * 2;

  return s;
}
