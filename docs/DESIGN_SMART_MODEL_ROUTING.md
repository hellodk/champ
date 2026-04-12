# Design: Smart Model Routing — Auto-Discovery + Task-Based Selection

Status: **design complete, ready for implementation**

---

## Problem

Today Champ uses a single hardcoded provider (`champ.provider: ollama` or `llamacpp`). If the user has multiple inference backends running with multiple models, Champ ignores all of them. The user must manually pick one model and use it for everything — chat, coding, completions, embeddings — regardless of suitability.

**Real-world setup (common among local LLM users):**
```
Mac Mini (M3 16GB)
├─ Ollama at :11434
│   ├─ qwen2.5-coder:7b-instruct    (coding, fast)
│   ├─ llama3.1:8b                   (general chat)
│   ├─ nomic-embed-text              (embeddings only)
│   └─ codestral:22b                 (coding, slower but smarter)
│
└─ llama.cpp at :21434
    └─ DeepSeek-Coder-V2-Lite-Q4    (coding, 16K ctx)
```

The user wants Champ to **use the right model for each task** without manual switching.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Extension Host                                                  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  SmartRouter                                                │ │
│  │                                                             │ │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐              │ │
│  │  │ Discovery │  │ Classifier│  │  Selector  │              │ │
│  │  │           │  │           │  │            │              │ │
│  │  │ scans all │→ │ tags each │→ │ picks best │→ provider    │ │
│  │  │ providers │  │ model by  │  │ model for  │  .chat()     │ │
│  │  │ for live  │  │ name/size │  │ the current│              │ │
│  │  │ models    │  │ heuristic │  │ task type  │              │ │
│  │  └───────────┘  └───────────┘  └───────────┘              │ │
│  │       ↑                              ↑                      │ │
│  │       │                              │                      │ │
│  │  On activation              AgentController calls           │ │
│  │  (background,               router.select(taskType)         │ │
│  │   non-blocking)             before each LLM call            │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Providers (existing, unchanged)                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │  Ollama  │ │ llama.cpp│ │   vLLM   │ │  Claude  │          │
│  │ .chat()  │ │ .chat()  │ │ .chat()  │ │ .chat()  │          │
│  │ .list()  │ │ .list()  │ │ .list()  │ │          │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Discovery (on activation, background, non-blocking)

```
activate()
    │
    ├──► DO NOT AWAIT — fire and forget
    │
    ▼
SmartRouter.discover()
    │
    ├──► Ollama: GET /api/tags ──────────► [{name: "qwen2.5-coder:7b", ...}, ...]
    │    (parallel)
    ├──► llama.cpp: GET /props ──────────► {n_ctx: 16384, model: "deepseek-v2"}
    │    (parallel)
    ├──► vLLM: GET /v1/models ───────────► [{id: "Llama-3.1-8B"}, ...]
    │    (parallel, if configured)
    ├──► Claude: skip (cloud — no discovery needed, always available)
    │
    ▼
    Merge results into DiscoveredModel[]
    │
    ▼
    Classify each model (name heuristics)
    │
    ▼
    Cache in memory — never blocks UI
    │
    ▼
    Broadcast to webview (model picker updates)
```

**Performance**: All discovery calls run in `Promise.all()` with a **3-second per-provider timeout**. If a provider is offline, it's skipped silently. Total discovery latency: max 3 seconds, runs in background after `activate()` returns.

### 2. Classification (pure CPU, <1ms)

```
Model name                    → Tags
─────────────────────────────────────────────────
qwen2.5-coder:7b-instruct    → [coding, instruct, fast, 7B]
qwen2.5-coder:14b            → [coding, medium, 14B]
llama3.1:8b                   → [general, chat, fast, 8B]
codestral:22b                 → [coding, slow, 22B]
nomic-embed-text              → [embedding]
DeepSeek-Coder-V2-Lite        → [coding, instruct, medium, 16B]
claude-sonnet-4               → [general, coding, cloud, premium]
```

Classification is a **pure regex/string match** on the model name — no network calls, no LLM queries. Runs once per discovery cycle.

**Heuristic rules:**
```
name contains "coder|code|starcoder|codestral|deepseek-coder"  → coding
name contains "embed|nomic|bge|e5"                              → embedding
name contains "instruct|chat"                                   → instruct
size ≤ 7B or name contains ":1b|:3b|:7b"                       → fast
size 8B-16B                                                     → medium
size > 16B                                                      → slow
```

### 3. Selection (per LLM call, <0.1ms)

```
AgentController.processMessage()
    │
    ├── taskType = deriveTaskType(mode, history)
    │     agent mode + tool calls pending → "coding"
    │     ask mode, no tool context       → "chat"
    │     inline completion trigger       → "completion"
    │     @Codebase query                 → "embedding"
    │
    ├── provider = smartRouter.select(taskType)
    │     │
    │     ├── taskType = "coding"
    │     │   → prefer: coding + instruct + largest that fits in memory
    │     │   → result: DeepSeek-Coder-V2-Lite (llama.cpp)
    │     │
    │     ├── taskType = "chat"
    │     │   → prefer: general + chat + fast
    │     │   → result: llama3.1:8b (ollama)
    │     │
    │     ├── taskType = "completion"
    │     │   → prefer: coding + fast + smallest
    │     │   → result: qwen2.5-coder:7b (ollama)
    │     │
    │     └── taskType = "embedding"
    │         → prefer: embedding-tagged model
    │         → result: nomic-embed-text (ollama)
    │
    ▼
    provider.chat(messages, options)
```

**Performance**: Selection is an in-memory array scan with scoring — O(n) where n is the number of discovered models (typically <20). Takes microseconds. No allocation, no network, no blocking.

---

## Model Picker UX

```
┌──────────────────────────────────────────┐
│ Search models                            │
├──────────────────────────────────────────┤
│                                          │
│ ── Routing Mode ──────────────────────── │
│ ● Smart (Champ picks per task)       ✓   │
│ ○ Manual (I choose one model)            │
│                                          │
│ ── Active Selection ──────────────────── │
│ Chat:       llama3.1:8b      (ollama)    │
│ Coding:     DeepSeek-V2      (llama.cpp) │
│ Completion: qwen2.5-coder:7b (ollama)    │
│ Embedding:  nomic-embed-text (ollama)    │
│                                          │
│ ── All Models (6 found) ──────────────── │
│   qwen2.5-coder:7b      ollama    coding │
│   qwen2.5-coder:14b     ollama    coding │
│   llama3.1:8b            ollama    chat   │
│   codestral:22b          ollama    coding │
│   nomic-embed-text       ollama    embed  │
│   DeepSeek-Coder-V2      llama.cpp coding │
│                                          │
│ + Add provider                           │
│ ↻ Re-scan models                         │
└──────────────────────────────────────────┘
```

When the user selects "Manual" and picks a specific model, that model is locked for the session. Clicking "Smart" switches back to automatic routing.

---

## Module Design

### New: `src/providers/smart-router.ts`

```typescript
export type TaskType = "coding" | "chat" | "completion" | "embedding";

export type ModelCapability =
  | "coding" | "general" | "embedding" | "instruct";

export type ModelSpeed = "fast" | "medium" | "slow";

export interface DiscoveredModel {
  id: string;              // "qwen2.5-coder:7b-instruct"
  providerName: string;    // "ollama"
  providerType: string;    // "ollama" | "llamacpp" | "vllm" | etc.
  capabilities: ModelCapability[];
  speed: ModelSpeed;
  contextWindow: number;   // detected via /props or /api/show
  sizeHint: string;        // "7B", "14B", "22B" — extracted from name
}

export interface RouteResult {
  model: DiscoveredModel;
  provider: LLMProvider;
  reason: string;          // "coding + instruct + largest available"
}

export class SmartRouter {
  private models: DiscoveredModel[] = [];
  private providers = new Map<string, LLMProvider>();
  private mode: "smart" | "manual" = "smart";
  private manualSelection: string | null = null;

  /**
   * Discover models from all configured providers.
   * Runs in parallel with a per-provider timeout.
   * Non-blocking — call with void, don't await in activate().
   */
  async discover(
    providerConfigs: Map<string, { provider: LLMProvider; type: string }>,
  ): Promise<void>;

  /**
   * Select the best model for a given task type.
   * Returns the provider instance + model id.
   * In manual mode, always returns the locked selection.
   * In smart mode, scores all discovered models and picks the best.
   */
  select(taskType: TaskType): RouteResult | null;

  /** Get all discovered models for the UI. */
  getModels(): DiscoveredModel[];

  /** Switch between smart and manual mode. */
  setMode(mode: "smart" | "manual"): void;

  /** Lock to a specific model (manual mode). */
  setManualModel(modelId: string): void;
}
```

### Classification heuristics (pure string matching)

```typescript
function classify(name: string): {
  capabilities: ModelCapability[];
  speed: ModelSpeed;
  sizeHint: string;
} {
  const lower = name.toLowerCase();
  const capabilities: ModelCapability[] = [];

  // Capability detection
  if (/coder|code|starcoder|codestral|deepseek-coder|codellama/.test(lower))
    capabilities.push("coding");
  if (/embed|nomic|bge|e5|gte/.test(lower))
    capabilities.push("embedding");
  if (/instruct|chat/.test(lower))
    capabilities.push("instruct");
  if (capabilities.length === 0)
    capabilities.push("general");

  // Size detection
  const sizeMatch = lower.match(/(\d+\.?\d*)b/);
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : 7;
  const sizeHint = sizeMatch ? `${sizeMatch[1]}B` : "unknown";

  // Speed from size
  let speed: ModelSpeed = "medium";
  if (sizeB <= 7) speed = "fast";
  else if (sizeB > 16) speed = "slow";

  return { capabilities, speed, sizeHint };
}
```

### Scoring algorithm

```typescript
function score(model: DiscoveredModel, taskType: TaskType): number {
  let s = 0;

  switch (taskType) {
    case "coding":
      // Prefer coding-capable models, then largest, then instruct
      if (model.capabilities.includes("coding")) s += 100;
      if (model.capabilities.includes("instruct")) s += 20;
      // Larger models score higher for coding quality
      s += parseSizeB(model.sizeHint) * 2;
      break;

    case "chat":
      // Prefer general or instruct, then fast
      if (model.capabilities.includes("general")) s += 80;
      if (model.capabilities.includes("instruct")) s += 40;
      if (model.speed === "fast") s += 30;
      break;

    case "completion":
      // Ghost text: speed is king, coding-capable preferred
      if (model.speed === "fast") s += 100;
      if (model.capabilities.includes("coding")) s += 50;
      // Smaller = faster latency for completions
      s -= parseSizeB(model.sizeHint);
      break;

    case "embedding":
      // Only embedding-tagged models qualify
      if (model.capabilities.includes("embedding")) s += 200;
      else s -= 999;  // disqualify non-embedding models
      break;
  }

  // Bonus for larger context window
  s += Math.log2(model.contextWindow) * 2;

  return s;
}
```

---

## Performance Guarantees

| Operation | When | Latency | Blocks UI? |
|-----------|------|---------|------------|
| Discovery | Activation (background) | ≤3s total (parallel + timeout) | No |
| Classification | After discovery | <1ms (string regex) | No |
| Selection | Every processMessage | <0.1ms (array scan) | No |
| Re-scan | User clicks ↻ | ≤3s | No (async) |
| Model picker render | On click | <1ms (DOM update) | No |

**Key performance rules:**
1. `activate()` returns instantly — discovery is fire-and-forget
2. Zero network calls in the hot path (`select()` is pure memory)
3. Provider discovery has a **3-second timeout per provider** — offline providers don't block
4. Discovery results are **cached** — only re-fetched on explicit re-scan or config change
5. Classification is **pure CPU** — regex on model names, no LLM queries
6. The webview only re-renders when the model list actually changes (not on every tick)

---

## Sequence Diagram — Smart Routing in Action

```
User                    AgentController          SmartRouter         Providers
 │                            │                      │                   │
 │ "create a rust hello       │                      │                   │
 │  world file"               │                      │                   │
 ├───────────────────────────►│                      │                   │
 │                            │ select("coding")     │                   │
 │                            ├─────────────────────►│                   │
 │                            │                      │ score all models  │
 │                            │                      │ DeepSeek-V2: 134  │
 │                            │                      │ qwen-coder:7b: 98 │
 │                            │                      │ llama3.1: 42      │
 │                            │                      │                   │
 │                            │◄─────────────────────┤                   │
 │                            │ RouteResult:         │                   │
 │                            │  DeepSeek-V2         │                   │
 │                            │  (llama.cpp)         │                   │
 │                            │                      │                   │
 │                            │ processMessage()     │                   │
 │                            ├──────────────────────────────────────────►
 │                            │                      │   llama.cpp       │
 │                            │                      │   .chat()         │
 │                            │◄──────────────────────────────────────────
 │                            │                      │                   │
 │◄───────────────────────────┤                      │                   │
 │ "I'll create hello.rs..."  │                      │                   │
```

---

## Config — Zero Required, Full Override Available

### No config needed (default)

If the user has providers accessible (Ollama running, llama.cpp running), Champ discovers everything automatically. No `.champ/config.yaml` required.

### Optional override in `.champ/config.yaml`

```yaml
# Smart routing is ON by default. Override here if needed.
routing:
  mode: smart           # "smart" or "manual"
  # Per-task overrides (optional — smart mode fills these automatically):
  coding: deepseek-coder-v2-lite    # force this model for coding tasks
  chat: llama3.1:8b                  # force this for chat
  completion: qwen2.5-coder:1.5b    # force this for ghost-text
  embedding: nomic-embed-text        # force this for embeddings

# Providers to scan for models (all with baseUrl are scanned):
providers:
  ollama:
    baseUrl: http://localhost:11434
  llamacpp:
    baseUrl: http://192.168.1.24:21434/v1
```

---

## Migration Path

- **No breaking changes** — existing `champ.provider` setting still works
- If `routing.mode` is absent, Champ uses the legacy single-provider behavior
- If ANY provider has `baseUrl` configured, Champ auto-scans it during discovery
- Users who want smart routing just start a second provider — Champ detects it

---

## Success Criteria

- [ ] Champ discovers models from all configured providers on activation
- [ ] Model picker shows all discovered models grouped by provider
- [ ] "Smart" mode picks the best model per task without user intervention
- [ ] "Manual" mode locks to one model for the session
- [ ] Ghost-text completions use the fastest coding model
- [ ] Embeddings use the embedding model (never a chat model)
- [ ] Zero impact on VS Code startup time (discovery is background)
- [ ] Offline providers are skipped in ≤3 seconds
- [ ] All existing 521 tests still pass
