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

export type ModelSource =
  | "discovered" // confirmed by querying the server — safe to route
  | "static-cloud" // cloud provider catalog (Claude, OpenAI, Gemini) — valid when API key set
  | "config-fallback"; // guessed from YAML config when server offline — DO NOT route

export interface DiscoveredModel {
  id: string;
  providerName: string;
  providerType: string;
  capabilities: ModelCapability[];
  speed: ModelSpeed;
  contextWindow: number;
  sizeHint: string;
  quantizationLevel: string; // e.g. "Q4_0", "Q4_K_M", "F16", ""
  /** How this model entered the registry. Only "discovered" and "static-cloud" are routed. */
  source?: ModelSource;
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

const DISCOVERY_TIMEOUT_MS = 5_000; // 5s — allows remote LAN servers (was 2s, too short)

export class SmartRouter {
  private models: DiscoveredModel[] = [];
  private staticModels: DiscoveredModel[] = [];
  private providerMap = new Map<string, ProviderEntry>();
  private mode: "smart" | "manual" = "smart";
  private manualModelId: string | null = null;
  private taskOverrides = new Map<TaskType, string | null>();
  private listeners = new Set<() => void>();
  private discovered = false;
  private lastModelsSig = "";
  private discovering = false; // Fix 4: race guard
  private pendingRediscover = false; // missed-wake guard
  private routeCache = new Map<string, RouteResult | null>(); // Fix 6: cache
  /**
   * When set, smart routing is restricted to models from this provider.
   * Cross-provider routing only happens when null (full smart mode) or when
   * the user has explicitly configured routing.mode in their YAML.
   * Set to the YAML `provider:` value so `provider: llamacpp` keeps llamacpp.
   */
  private activeProviderName: string | null = null;
  /** User-defined routing rules loaded from config. */
  private routingRules: Array<{
    match: string;
    provider: string;
    model: string;
  }> = [];

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
   * Register a static list of models for providers that cannot be discovered
   * via network scanning (e.g. cloud APIs like Claude and OpenAI that require
   * an API key for /models endpoints). Static models are merged with discovered
   * ones and take the same routing logic. Call before discover().
   */
  registerStaticModels(models: DiscoveredModel[]): void {
    this.staticModels = models;
    this.routeCache.clear();
  }

  /**
   * Append a single config-fallback placeholder without wiping the cloud
   * catalog registered by registerStaticModels(). Called after discovery
   * when a provider returned 0 models (server offline at startup) — allows
   * the model picker to show the configured model name as a hint.
   * Never routes to config-fallback models (see select()).
   */
  appendFallbackModel(model: DiscoveredModel): void {
    // Don't add if already exists (by provider + id) to avoid duplicates
    // when the config-reload path fires repeatedly.
    const exists = this.staticModels.some(
      (m) => m.id === model.id && m.providerName === model.providerName,
    );
    if (!exists) {
      this.staticModels = [...this.staticModels, model];
      this.routeCache.clear();
    }
  }

  /**
   * Discover models from all registered providers in parallel.
   * Non-blocking — call with `void`, don't await during activation.
   *
   * Emits incremental onChange events as each provider responds so the
   * UI can show discovered models immediately without waiting for the
   * slowest provider to time out.
   */
  async discover(): Promise<void> {
    // Fix 4: debounce concurrent calls; track if a re-discover was requested
    // while one was already in flight (missed-wake guard).
    if (this.discovering) {
      this.pendingRediscover = true;
      return;
    }
    this.discovering = true;
    // Accumulate raw discovered models per-provider as they resolve.
    const rawByProvider = new Map<string, DiscoveredModel[]>();
    try {
      const entries = Array.from(this.providerMap.entries());
      const promises = entries.map(([name, entry]) =>
        this.discoverFromProvider(name, entry)
          .then((models) => {
            if (models.length === 0) return;
            rawByProvider.set(name, models);
            // Emit a partial result immediately so the UI updates as each
            // provider responds — no need to wait for the slowest one.
            const allRaw = Array.from(rawByProvider.values()).flat();
            // discovered beats config-fallback in partial list too
            const partialCandidates = [
              ...allRaw,
              ...this.staticModels.filter(
                (m) => m.source !== "config-fallback",
              ),
              ...this.staticModels.filter(
                (m) => m.source === "config-fallback",
              ),
            ];
            const seen = new Set<string>();
            const partial = partialCandidates.filter((m) => {
              const key = `${m.providerName}:${m.id}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            this.models = partial;
            this.discovered = true;
            const sig = partial
              .map((m) => `${m.providerName}:${m.id}`)
              .sort()
              .join("|");
            if (sig !== this.lastModelsSig) {
              this.lastModelsSig = sig;
              this.emit();
            }
          })
          .catch(() => undefined),
      );
      await Promise.allSettled(promises);

      // Final dedup pass — discovered beats config-fallback when the same
      // model appears in both (e.g. fallback registered before Ollama responded).
      // Priority: discovered > static-cloud > config-fallback
      const allRaw = Array.from(rawByProvider.values()).flat();
      const allCandidates = [
        ...allRaw,
        ...this.staticModels.filter((m) => m.source !== "config-fallback"),
        ...this.staticModels.filter((m) => m.source === "config-fallback"),
      ];
      const seen = new Set<string>();
      const allModels = allCandidates.filter((m) => {
        const key = `${m.providerName}:${m.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const wasDiscovered = this.discovered;
      this.models = allModels;
      this.discovered = true;

      const sig = allModels
        .map((m) => `${m.providerName}:${m.id}`)
        .sort()
        .join("|");
      // Always emit on first discovery (signals readiness); after that only
      // emit when the model list actually changed (prevents UI chatter).
      if (!wasDiscovered || sig !== this.lastModelsSig) {
        this.lastModelsSig = sig;
        this.routeCache.clear(); // new models = stale routes
        this.emit();
      }

      if (allModels.length > 0) {
        console.log(
          `Champ SmartRouter: discovered ${allModels.length} model(s) from ${entries.length} provider(s)`,
        );
      }
    } finally {
      this.discovering = false;
      // Flush any missed wake that arrived while we were busy
      if (this.pendingRediscover) {
        this.pendingRediscover = false;
        void this.discover();
      }
    }
  }

  /**
   * Select the best model for a given task. In manual mode, returns the
   * locked selection. In smart mode, scores all models and picks the best.
   * Pass `currentFile` to allow user routing rules to match by file extension.
   */
  select(taskType: TaskType, currentFile?: string): RouteResult | null {
    // Fix 6: cache lookup — include currentFile in key when rules exist
    const cacheKey = `${taskType}:${this.mode}:${this.manualModelId ?? ""}:${this.routingRules.length > 0 ? (currentFile ?? "") : ""}`;
    if (this.routeCache.has(cacheKey))
      return this.routeCache.get(cacheKey) ?? null;

    const result = this._selectUncached(taskType, currentFile);
    this.routeCache.set(cacheKey, result);
    return result;
  }

  private _selectUncached(
    taskType: TaskType,
    currentFile?: string,
  ): RouteResult | null {
    // User-defined routing rules take highest priority (before task overrides
    // and automatic routing). This allows per-file-type or per-task overrides
    // that map directly to a named provider + model.
    const userRule = this.checkUserRules(taskType, currentFile);
    if (userRule) {
      const entry = this.providerMap.get(userRule.provider);
      if (entry) {
        // Build a synthetic DiscoveredModel for the rule-selected model.
        const ruleModel: DiscoveredModel = {
          id: userRule.model,
          providerName: userRule.provider,
          providerType: entry.type,
          capabilities: ["general"],
          speed: "medium",
          contextWindow: 8192,
          sizeHint: "unknown",
          quantizationLevel: "",
        };
        // Prefer the richer discovered metadata if the model was confirmed.
        const discovered = this.models.find(
          (m) =>
            m.id === userRule.model &&
            m.providerName === userRule.provider &&
            m.source !== "config-fallback",
        );
        if (!discovered) {
          console.warn(
            `Champ SmartRouter: user routing rule model "${userRule.model}" was not found on provider "${userRule.provider}" — routing anyway per user config.`,
          );
        }
        // User explicitly requested this model — honour it even if unverified.
        // Use source "static-cloud" so the routing guard doesn't block it.
        return {
          model: discovered ?? {
            ...ruleModel,
            source: "static-cloud" as const,
          },
          provider: entry.provider,
          reason: `user rule: ${userRule.provider}/${userRule.model}`,
        };
      }
      console.warn(
        `Champ SmartRouter: user routing rule references unknown provider "${userRule.provider}" — falling back to auto-routing.`,
      );
    }

    // Per-task model override from routing config (routing.coding, etc.)
    if (this.taskOverrides.has(taskType)) {
      const override = this.taskOverrides.get(taskType);
      if (override !== null && override !== undefined) {
        const model = this.models.find((m) => m.id === override);
        if (model) {
          // Guard: never use an embedding model for a non-embedding task,
          // even when explicitly overridden in config — it will always error.
          if (
            taskType !== "embedding" &&
            model.capabilities.includes("embedding")
          ) {
            console.warn(
              `Champ SmartRouter: routing.${taskType} override "${override}" is an embedding model — ignoring.`,
            );
          } else {
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
    }

    // Fix 5: manual model set but not yet discovered — return null so caller
    // can show "waiting for discovery" rather than auto-selecting something else
    if (this.mode === "manual" && this.manualModelId) {
      const model = this.models.find((m) => m.id === this.manualModelId);
      if (model) {
        // Guard: never use an embedding model for a non-embedding task.
        if (
          taskType !== "embedding" &&
          model.capabilities.includes("embedding")
        ) {
          // Fall through to smart selection rather than erroring
        } else {
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
      return null;
    }

    if (this.models.length === 0) return null;

    // When the user set an explicit `provider:` in their YAML, restrict routing
    // to that provider's models. This prevents SmartRouter from silently
    // switching to a different provider (e.g. ollama) just because it has
    // higher-scoring models. Cross-provider routing requires explicit config:
    //   routing:
    //     mode: smart   # (default locks to active provider — set this to unlock)
    const candidateModels = this.activeProviderName
      ? this.models.filter((m) => m.providerName === this.activeProviderName)
      : this.models;
    // Exclude config-fallback models from routing at the pool level too.
    // They are placeholders only — the server never confirmed they exist.
    const routableCandidates = candidateModels.filter(
      (m) => m.source !== "config-fallback",
    );
    const routableAll = this.models.filter(
      (m) => m.source !== "config-fallback",
    );
    // Fall back to all routable models if the active provider has none reachable.
    const modelPool =
      routableCandidates.length > 0 ? routableCandidates : routableAll;

    let best: DiscoveredModel | null = null;
    let bestScore = -Infinity;
    let bestReason = "";

    for (const model of modelPool) {
      // Never route to a config-fallback model — it exists only for the UI
      // picker and was never confirmed by the server. Routing to it would
      // produce a "model not found" error (exactly the original qwen bug).
      if (model.source === "config-fallback") continue;

      // Hard-exclude embedding models from non-embedding tasks.
      // The -999 score penalty is a soft signal; this is the hard gate.
      if (
        taskType !== "embedding" &&
        model.capabilities.includes("embedding")
      ) {
        continue;
      }
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

  /** Returns the number of discovered models for a specific provider. */
  getModelCount(providerName: string): number {
    return this.models.filter((m) => m.providerName === providerName).length;
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

  /**
   * Restrict smart routing to models from this provider only.
   * Call with the YAML `provider:` value so the user's explicit choice
   * is honoured — SmartRouter won't silently switch to a different provider.
   * Pass null to allow full cross-provider routing.
   */
  setActiveProvider(providerName: string | null): void {
    this.activeProviderName = providerName;
    this.routeCache.clear();
  }

  getActiveProvider(): string | null {
    return this.activeProviderName;
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

  /**
   * Set user-defined routing rules from config. Rules are evaluated before
   * automatic routing. Pass an empty array to clear all rules.
   */
  setRoutingRules(
    rules: Array<{ match: string; provider: string; model: string }>,
  ): void {
    this.routingRules = rules ?? [];
    this.routeCache.clear();
  }

  /**
   * Check user-defined routing rules before auto-routing.
   * Returns null if no rule matches.
   */
  private checkUserRules(
    taskType: string,
    currentFile?: string,
  ): { provider: string; model: string } | null {
    for (const rule of this.routingRules) {
      // Match by task type
      if (rule.match === taskType)
        return { provider: rule.provider, model: rule.model };
      // Match by file extension glob
      if (currentFile && this.matchGlob(rule.match, currentFile)) {
        return { provider: rule.provider, model: rule.model };
      }
    }
    return null;
  }

  private matchGlob(pattern: string, filePath: string): boolean {
    // Simple glob: *.ext matches any file with that extension
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1); // ".ts"
      return filePath.endsWith(ext);
    }
    // Exact match
    return pattern === filePath;
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
   * Discover models from a single provider with a hard timeout.
   * Uses AbortController so in-flight fetch calls are actually cancelled
   * when the timeout fires — no resource leak.
   */
  private async discoverFromProvider(
    name: string,
    entry: ProviderEntry,
  ): Promise<DiscoveredModel[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    try {
      return await this.fetchModels(name, entry, controller.signal);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return [];
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchModels(
    name: string,
    entry: ProviderEntry,
    signal: AbortSignal,
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
          // Classify by display name (better heuristics) but store by id
          const quantFromName = extractQuantFromName(m.name);
          const classified = classify(m.name, quantFromName);
          results.push({
            id: m.id, // use canonical ID, not display name
            providerName: name,
            providerType: entry.type,
            ...classified,
            contextWindow: 8192,
            source: "discovered" as const,
          });
        }
        if (results.length > 0) return results;
      } catch {
        /* fall through */
      }
    }

    // Fix 3: Fallback: try Ollama /api/tags — use real context window and quantization
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal });
      if (res.ok) {
        const data = (await res.json()) as {
          models?: Array<{
            name: string;
            details?: {
              parameter_size?: string;
              quantization_level?: string;
              context_length?: number;
            };
          }>;
        };
        for (const m of data.models ?? []) {
          const paramSize = m.details?.parameter_size ?? "";
          const quantLevel = m.details?.quantization_level ?? "";
          const contextLength = m.details?.context_length ?? 8192;
          const classified = classify(m.name, quantLevel);
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
            source: "discovered" as const,
          });
        }
        if (results.length > 0) return results;
      }
    } catch {
      /* offline or aborted */
    }

    // Fallback: try /v1/models (OpenAI-compatible)
    try {
      const cleanBase = baseUrl.replace(/\/v1\/?$/, "");
      const res = await fetch(`${cleanBase}/v1/models`, { signal });
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
            source: "discovered" as const,
          });
        }
      }
    } catch {
      /* offline or aborted */
    }

    // Fallback: try /props (llama.cpp)
    if (results.length === 0) {
      try {
        const cleanBase = baseUrl.replace(/\/v1\/?$/, "");
        const res = await fetch(`${cleanBase}/props`, { signal });
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
            source: "discovered" as const,
          });
        }
      } catch {
        /* offline or aborted */
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

  // Embedding models (exclusive — never mix with chat/coding).
  // Early return ensures embedding models ONLY get ["embedding"] — they never
  // accumulate "general" or "instruct" from later checks.
  if (
    /embed|nomic|bge|e5-|gte|jina|minilm|all-mini|mxbai|voyage|rerank|instructor|mpnet|labse|sentence-t5|splade/.test(
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

  // Coding-specialist models.
  // Use \bcoder to avoid false-positive on "decoder" (common architecture term).
  if (
    /\bcoder|codestral|deepseek-coder|codellama|wizardcoder|starcoder/.test(
      lower,
    )
  ) {
    capabilities.push("coding");
  }

  // Instruction-tuned models.
  // [-_.]it matches the standard "-it" / "_it" suffix (gemma-2-9b-it, phi3-mini-it).
  // Avoids false positives from words that end in "it" (audit, orbit, profit).
  if (/instruct|chat|[-_.]it(?:\b|$)/.test(lower)) {
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
  let sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : 7;
  let sizeHint = sizeMatch ? `${sizeMatch[1]}B` : "unknown";

  // MoE (Mixture-of-Experts) size correction: the per-expert size from the model
  // name (e.g. "8x7B" → 7B) massively underestimates memory footprint because
  // ALL expert weights must reside in VRAM even though only 2 are active per token.
  // Use experts × per-expert as the effective size for speed/scoring purposes.
  const moeMatch = lower.match(/(\d+)x(\d+\.?\d*)b/);
  if (moeMatch) {
    const experts = parseInt(moeMatch[1], 10);
    const perExpert = parseFloat(moeMatch[2]);
    sizeB = experts * perExpert;
    sizeHint = `${sizeB}B`; // e.g. "46B" for mixtral:8x7b
  }

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
