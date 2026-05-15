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
  quantizationLevel: string; // Fix 7: e.g. "Q4_0", "Q4_K_M", "F16", ""
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
  private discovering = false; // Fix 4: race guard
  private routeCache = new Map<string, RouteResult | null>(); // Fix 6: cache

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
    // Fix 4: debounce concurrent calls
    if (this.discovering) return;
    this.discovering = true;
    try {
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
    } finally {
      this.discovering = false;
    }
  }

  /**
   * Select the best model for a given task. In manual mode, returns the
   * locked selection. In smart mode, scores all models and picks the best.
   */
  select(taskType: TaskType): RouteResult | null {
    // Fix 6: cache lookup
    const cacheKey = `${taskType}:${this.mode}:${this.manualModelId ?? ""}`;
    if (this.routeCache.has(cacheKey))
      return this.routeCache.get(cacheKey) ?? null;

    const result = this._selectUncached(taskType);
    this.routeCache.set(cacheKey, result);
    return result;
  }

  private _selectUncached(taskType: TaskType): RouteResult | null {
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

    // Fix 5: manual model set but not yet discovered — return null so caller
    // can show "waiting for discovery" rather than auto-selecting something else
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
      return null;
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
    // Only report as discovered if at least one model was actually found.
    // Returning true with an empty model list misleads callers into thinking
    // the router is ready when all providers were unreachable.
    return this.discovered && this.models.length > 0;
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
    // Task override changes affect routing — must invalidate the route cache
    // so the next select() re-evaluates with the new override in effect.
    this.routeCache.clear();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // Fix 6: invalidate route cache on model list changes
    this.routeCache.clear();
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
        // Use safe context default; extract quantization from name when not in metadata
        for (const m of models) {
          const quantFromName = extractQuantFromName(m.name);
          const classified = classify(m.name, quantFromName);
          results.push({
            id: m.name,
            providerName: name,
            providerType: entry.type,
            ...classified,
            contextWindow: 8192, // safe default; /api/tags overrides this for Ollama
          });
        }
        if (results.length > 0) return results;
      } catch {
        /* fall through */
      }
    }

    // Fix 3: Fallback: try Ollama /api/tags — use real context window and quantization
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{
            name: string;
            details?: {
              parameter_size?: string; // e.g. "8B", "14B"
              quantization_level?: string; // e.g. "Q4_0", "Q4_K_M"
              context_length?: number;
            };
          }>;
        };
        for (const m of data.models ?? []) {
          // Use parameter_size from details if available (more reliable than name parsing)
          const paramSize = m.details?.parameter_size ?? "";
          const quantLevel = m.details?.quantization_level ?? "";
          const contextLength = m.details?.context_length ?? 8192;

          // Merge name-based and details-based size info
          const classified = classify(m.name, quantLevel);

          // Override sizeHint with more reliable details data if available
          const sizeHint = paramSize || classified.sizeHint;

          results.push({
            id: m.name,
            providerName: name,
            providerType: entry.type,
            capabilities: classified.capabilities,
            speed: classified.speed,
            sizeHint,
            quantizationLevel: quantLevel,
            contextWindow: contextLength,
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
 * Extract quantization level from a model name string when it's not available
 * as a separate metadata field (e.g., from listModels() responses).
 * Returns empty string if not detectable.
 */
function extractQuantFromName(name: string): string {
  const lower = name.toLowerCase();
  const m = lower.match(/[:\-_](q\d[_k_ms]*(?:\d[_k_ms]*)*|f16|f32|bf16)/);
  return m ? m[1].toUpperCase() : "";
}

/**
 * Fix 1: Classify a model by name heuristics with known families, embedding
 * exclusivity, quantization-aware speed, and "general" always included for
 * non-embedding models. Pure string matching, <1ms.
 */
function classify(
  name: string,
  quantization?: string,
): {
  capabilities: ModelCapability[];
  speed: ModelSpeed;
  sizeHint: string;
  quantizationLevel: string;
} {
  const lower = name.toLowerCase();
  const capabilities: ModelCapability[] = [];

  // Embedding models (exclusive — never mix with chat/coding)
  if (
    /embed|nomic|bge|e5-|gte|jina|minilm|all-mini|mxbai|voyage|rerank/.test(
      lower,
    )
  ) {
    capabilities.push("embedding");
    return {
      capabilities,
      speed: "fast",
      sizeHint: "unknown",
      quantizationLevel: quantization ?? "",
    };
  }

  // Coding-specialist models
  if (
    /coder|codestral|deepseek-coder|codellama|wizardcoder|starcoder/.test(lower)
  ) {
    capabilities.push("coding");
  }

  // Instruction-tuned models (gguf removed — it's a file format, not a capability)
  if (/instruct|chat|it\b/.test(lower)) {
    capabilities.push("instruct");
  }

  // Models known to be excellent at coding regardless of name.
  // Covers: llama3:8b (colon, no dot), llama3.1:8b (dot), gemma2/3/4, phi3/4,
  // qwen (all versions), mistral, deepseek, hermes, neural.
  // llama-3\. removed — Ollama never uses dash-3 naming.
  if (
    /qwen|llama3[:._ -]|llama3$|gemma[2-4]|phi[34]|mistral|deepseek|hermes|neural/.test(
      lower,
    )
  ) {
    if (!capabilities.includes("coding")) capabilities.push("coding");
  }

  // All non-embedding models can do general tasks
  capabilities.push("general");

  // Size detection — match parameter count (after ":" or "-" separator, or trailing)
  // Avoids matching version numbers like "phi4" or "llama3"
  const sizeMatch =
    lower.match(/(?:[:_\-x]|^)(\d+\.?\d*)b(?:\b|$)/) ??
    lower.match(/(\d+\.?\d*)b$/);
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : 7;
  const sizeHint = sizeMatch ? `${sizeMatch[1]}B` : "unknown";

  // Quantization-aware speed classification
  const quant = (quantization ?? "").toLowerCase();
  const quantMultiplier = quant.includes("q2")
    ? 1.8
    : quant.includes("q4")
      ? 1.5
      : quant.includes("q5")
        ? 1.2
        : quant.includes("q8")
          ? 1.0
          : quant.includes("f16")
            ? 0.7
            : 1.0; // unknown quantization

  const effectiveSize = sizeB / quantMultiplier;
  const speed: ModelSpeed =
    effectiveSize <= 7 ? "fast" : effectiveSize > 16 ? "slow" : "medium";

  return {
    capabilities,
    speed,
    sizeHint,
    quantizationLevel: quantization ?? "",
  };
}

/**
 * Fix 2: Score a model for a given task type. Latency-aware, context-window-
 * meaningful, instruct-respecting. Higher = better fit.
 */
function score(model: DiscoveredModel, taskType: TaskType): number {
  let s = 0;
  const sizeHintNum = parseFloat(model.sizeHint);
  const sizeB = isNaN(sizeHintNum) ? 7 : sizeHintNum;

  switch (taskType) {
    case "coding":
      // Capability bonuses
      if (model.capabilities.includes("coding")) s += 100;
      if (model.capabilities.includes("instruct")) s += 25;
      if (model.capabilities.includes("embedding")) s -= 999;
      // Size: modest bonus — bigger isn't always better if it's slow
      s += Math.min(sizeB, 30); // cap at 30B equivalent
      // Speed: penalize slow models for coding (10x latency matters)
      // Note: fast bonus kept small so larger models still win over smaller+faster ones
      if (model.speed === "fast") s += 5;
      if (model.speed === "slow") s -= 35;
      break;

    case "chat":
      // Instruct/general — both good, instruct now correctly preferred
      if (model.capabilities.includes("instruct")) s += 80;
      if (model.capabilities.includes("general")) s += 60;
      if (model.capabilities.includes("coding")) s += 20; // coding models are good at chat too
      if (model.capabilities.includes("embedding")) s -= 999;
      // Speed matters for interactive chat
      if (model.speed === "fast") s += 30;
      if (model.speed === "slow") s -= 15;
      break;

    case "completion":
      // Inline autocomplete: speed is king
      if (model.capabilities.includes("embedding")) s -= 999;
      if (model.speed === "fast") s += 100;
      if (model.speed === "medium") s += 40;
      if (model.speed === "slow") s -= 50;
      if (model.capabilities.includes("coding")) s += 50;
      s -= Math.max(0, sizeB - 7) * 2; // penalize large models
      break;

    case "embedding":
      if (model.capabilities.includes("embedding")) s += 200;
      else s -= 999;
      break;
  }

  // Context window: meaningful linear bonus (not log — we care about the difference)
  // 4K base, +1 point per 4K above baseline, capped at +40
  const ctxBonus = Math.min(
    40,
    Math.max(0, (model.contextWindow - 4096) / 4096),
  );
  s += ctxBonus;

  return s;
}
