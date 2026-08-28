# Champ — New Implementation Plan: Guided Provider Setup, Context Truth, and Decode/Preflfill Intelligence

**Status:** Proposed · **Target:** v1.8.0
**Owner:** champ core maintainers
**Related docs:** `docs/CONFIG.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN_SMART_MODEL_ROUTING.md`
**Ticket map:** see [Tasks](#10-task-breakdown--tickets)

---

## 0. TL;DR

Champ's configuration and inference layer is being rebuilt around four workstreams. Configuration moves to **YAML-only**: the legacy flat `champ.*` VS Code settings are removed, and every entry point (status bar, chat-header gear, first-run) now launches **one guided setup wizard** that walks the user through provider → endpoint → API key → **live model auto-detection** → config write, with keys always stored in `SecretStorage`.

**Workstream A — Guided provider setup.** Replace "open VS Code settings" with a wizard. Pick provider (local vs cloud), endpoint (prefilled, probe-able), API key only when required (cloud, or any `401` from a self-hosted server), models **auto-discovered live** from the endpoint and pre-selected for the user. Result is written (merged, never clobbered) into `.champ/config.yaml` or `~/.champ/config.yaml`. Legacy `champ.*` provider/model/endpoint/key settings are deleted from the manifest, along with the dead settings-loading code path.

**Workstream B — Context-window truth.** Champ currently budgets prompts against a model's *theoretical* context length, which silently over-subscribes when a local backend serves a smaller window. B changes discovery + the provider layer to read the *runtime* window (`num_ctx` / `n_ctx`) with a strict fallback ladder, stores the resolved value, and splits each request into `input ≤ window − output-reserve`. Every downstream budget (compaction, teams, RAG packing) is corrected automatically by one shared source of truth.

**Workstream C — Decode parameters.** Today every request is `temperature 0.7`, fixed, for *every* task. C introduces task-aware decode profiles (tool-call vs code-gen vs chat vs autocomplete), routing through the existing model classifier, with per-provider field mapping and per-provider YAML overrides (`options:` block).

**Workstream D — Prefill & structured output.** Two improvements: (1) *assistant-prefill* — seed the assistant turn with the tool-call preamble so local models never narrate before calling tools; (2) *structured output* — grammar/JSON-schema-constrained generation where the backend supports it, making malformed tool calls structurally impossible. Companion requirement: keep the prompt prefix byte-stable so backend KV/prompt caches hit on multi-turn agent loops.

Each workstream is an independent ticket with its own failing tests. Commits are made per ticket; the full unit suite is the merge gate.

---

## 1. Background & Motivation

### 1.1 Current configuration surface (to be replaced)

Today Champ reads provider configuration from four layers in priority order:

```
workspace YAML  >  user YAML  >  VS Code champ.* settings  >  built-in defaults
```

The settings layer (`champ.provider`, `champ.ollama.baseUrl`, `champ.openaiCompatible.apiKey`, `champ.configSource`, …) is legacy and now actively harmful: two competing configuration vocabularies, a `configSource` knob to arbitrate them, and users unknowingly configuring the extension in *both* places. The settings layer dies.

### 1.2 Why a wizard, why not a settings page

The chat-header gear and status bar currently do *different things* (one opens VS Code settings for `champ`, the other opens/creates `config.yaml`). New users land in either and see an empty editor. The replacement is a **single, guided command** (`champ.configureProvider`) that produces a *valid, working* config every time:

1. It knows the provider catalogue (local vs cloud, default endpoints).
2. It probes the endpoint before writing — bad URLs fail fast with a fix.
3. It auto-detects models live instead of asking the user to know model IDs.
4. It prompts for API keys at exactly the right moment, and only when needed.
5. It writes a merged YAML file the rest of Champ already understands.

The wizard is native (QuickPick / InputBox), no webview work required, and reuses the existing file-watcher hot reload.

### 1.3 Competitor landscape

A leading competitor in the local-model space ships a provider extension that plugs models into an editor's native chat via a language-model provider API. Its advantages over Champ's current plumbing are narrow and specific — not the agent loop, not approvals, not RAG — but four of them are worth stealing:

1. **Runtime context reporting.** It queries each model's *served* context window (the `num_ctx` value baked into the running model, which reflects actual VRAM/RAM-allowed capacity), not the model's advertised maximum. The difference is large and consequential: an 8B model advertises a 128k window but typically serves 4k–32k on typical hardware. Champ uses the advertised maximum today → requests over-subscribe → backends hard-fail (`request exceeds available context size`).
2. **Input/output budget split.** It reports input and output limits as separate numbers derived from one shared window, so the caller never double-spends.
3. **Self-calibrating token estimation.** It adapts its chars-per-token ratio from observed usage per model instead of a fixed estimate.
4. **Picker-vs-server diagnostics.** A command that cross-checks what the UI offers against what the backend actually serves.

Champ already beats that competitor on the agent side (tools, approvals, multi-agent, RAG checkpoints). What it needs is the **context plumbing**.

### 1.4 Documented pain points this plan fixes

| Problem observed in the field | Root cause today | Fix |
|---|---|---|
| "Prompt too long / exceeds context" errors on local models | Budget = 75% of *advertised* window, not *served* window | B |
| Wizard-less setup → broken or half-configured installs | Config written by hand, no validation | A |
| Same 0.7 temperature for tool calls and creative chat | Single fixed decode profile | C |
| Local models narrate "I'll now search…" and never emit a tool call | Prompt-only tool calling, no prefill or grammar | D |
| Slow multi-turn agent loops on local hardware | No KV/prompt-cache reuse because prefix isn't stable | D |

---

## 2. Design: Workstream A — Guided Provider Setup (wizard + YAML-only)

### 2.1 Entry points → one command

```
status bar click ──────┐
chat-header gear ──────┼──▶ champ.configureProvider ──▶ wizard flow
"Champ: Configure Provider" ─┘
first-run detection ────────┘
```

`champ.openSettings` keeps its palette entry (command continues to exist) but its *behavior* is repurposed to launch the wizard. The old `workbench.action.openSettings("champ")` call is removed. `champ.setApiKey` is subsumed into the wizard (it stays registered for backward-compat, but the wizard calls it for the key step).

### 2.2 Wizard state machine

```
                    ┌──────────────────────────────────────────────────────┐
                    │              champ.configureProvider                 │
                    └──────────────────────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┴─────────────────────────────┐
        │   Step 0. Scope                                          │
        │   workspace open?                                        │
        │     Y → "Workspace (.champ/config.yaml)" [recommended]   │
        │         "User (~/.champ/config.yaml)"                    │
        │         + (if target exists) "Edit existing config"      │
        │     N → user scope (no choice)                           │
        └─────────────────────────────┬─────────────────────────────┘
                                      │
        ┌─────────────────────────────┴─────────────────────────────┐
        │  Step 1. Provider (QuickPick, grouped)                    │
        │   ── Local (key optional) ──                              │
        │     "Local · <backend A>"      (server detected @ port X) │
        │     "Local · <backend B>"      (not reachable)            │
        │     "Local · OpenAI-compatible (custom endpoint)"         │
        │   ── Cloud (API key required) ──                          │
        │     "Cloud · Claude"          (key saved ✓ / key needed)  │
        │     "Cloud · OpenAI"          (…)                         │
        │     "Cloud · Gemini"          (…)                         │
        └─────────────────────────────┬─────────────────────────────┘
                                      │
                 ┌────────────────────┴────────────────────┐
                 │        cloud provider?                  │
                 │   ┌──────┴──────┐                       │
                 │  yes           no                       │
                 │   │             │                       │
                 │   │             ▼                       │
                 │   │      Step 2. Endpoint (InputBox)    │
                 │   │      prefilled default per backend  │
                 │   │      "Probe endpoint" → /v1/models  │
                 │   │       200 → proceed (green)         │
                 │   │       401 → ask for key (Step 3)    │
                 │   │       000/refused → error + retry   │
                 │   │      openai-compatible: empty start │
                 │   │             │                       │
                 │   ▼             ▼                       │
                 │  Step 3. Key   │                       │
                 │  key stored?   │                       │
                 │  Y → skip      │                       │
                 │  N → password  │                       │
                 │      InputBox  │                       │
                 │      secrets.store                        │
                 │      (401-driven for local)              │
                 │             │                            │
                 └─────────────┼────────────────────────────┘
                               ▼
               ┌─────────────────────────────────────────────┐
               │  Step 4. Model auto-detect + pick          │
               │   live discovery against chosen endpoint:   │
               │     providers[].listModels()                │
               │        → native /api/tags                   │
               │        → /v1/models (OpenAI-compat)         │
               │        → /props (n_ctx world)               │
               │   "[scanning models…]" progress             │
               │   QuickPick of discovered models            │
               │   unreachable → "configure anyway (manual   │
               │      model) | Retry | Back"                 │
               │   cloud + key already present → AUTO-KEEP   │
               └──────────────────────┬──────────────────────┘
                                      ▼
               ┌─────────────────────────────────────────────┐
               │  Step 5. Write + reload                     │
               │   merge into chosen scope YAML, preserving   │
               │   existing keys (never clobber)             │
               │   provider: <id>                            │
               │   providers.<id>: {baseUrl, model, …}       │
               │   file watcher → loadProvider() → status    │
               │   toast: "Champ: configured → <model>"      │
               └─────────────────────────────────────────────┘
```

**Key prompting rules (per earlier decisions):**

- **API key prompt cadence.**
  - Cloud provider: prompt iff no key in `SecretStorage` (`champ.{provider}.apiKey`).
  - Cloud provider + key already present: **auto-keep** the current model, skip Step 4 pick.
  - Self-hosted: key prompt only when the endpoint probe returns **`401`**. Never pre-emptively.
- **Model pick.**
  - Local: always run live discovery against the endpoint; user picks from results.
  - If discovery fails (server unreachable), offer `"configure anyway (manual model)" | "Retry" | "Back"`.
- **Discovery endpoints** (see [3.1](#31-context-window-reconciliation--the-source-of-truth)) reuse the existing smart-router fetch ladder.

### 2.3 YAML writer: merge, never clobber

New pure helper `src/config/yaml-writer.ts`:

```
writeProviderToYaml(existingText | null, scope, { providerId, baseUrl, model, options })
```

- Parses existing YAML → object.
- Sets `provider` (top-level), `providers.<id>.{baseUrl, model}`.
- Deep-merges `options` from Workstream C if present.
- Round-trips the rest of the file (autocomplete, indexing, agent, mcp) untouched.
- Falls back to writing a fresh template when the file is absent or empty.

Unit tests: preserve unrelated keys, handle empty/absent file, handle `provider` already set, list-scope idempotency.

### 2.4 Removal of the legacy settings layer

| Remove from `package.json` `contributes.configuration` | Reason |
|---|---|
| `champ.provider` | YAML `provider:` |
| `champ.claude.model`, `champ.openai.model`, `champ.gemini.model` | YAML `providers.*.model` |
| `champ.ollama.baseUrl/model`, `champ.llamacpp.baseUrl`, `champ.vllm.baseUrl/apiKey`, `champ.openaiCompatible.*` | YAML `providers.*` |
| `champ.autocomplete.model`, `champ.autocomplete.provider` | YAML `autocomplete.*` |
| `champ.indexing.embeddingProvider` | YAML `indexing.embeddingProvider` |
| `champ.configSource` | settings layer deleted; single-source YAML |
| `champ.openaiCompatible.apiKey`, `champ.vllm.apiKey` | `SecretStorage` via wizard |

| Keep (runtime/UX, not provider-model config) |
|---|
| `champ.yoloMode`, `champ.autoFix.*`, `champ.indexing.enabled`, `champ.autocomplete.enabled`, `champ.autocomplete.debounceMs`, `champ.mcp.servers`, `champ.autoContext.enabled`, `champ.userRules` |

**Dead code to delete** (with their tests):

- `ProviderFactory.createFromConfig` + all `createClaude/OpenAI/Gemini/Ollama/LlamaCpp/VLLM/OpenAICompatible(config, secrets)` settings-reading methods + the `ConfigReader` interface → keep only `createFromChampConfig`.
- The `"settings"` source in the layered resolver.
- The `onDidChangeConfiguration → loadProvider()` watcher for provider keys.
- Branches in `loadProviderInner` that pick the settings vs YAML path.

**Migration safety net:** on activation, if stale `champ.provider` / `champ.ollama.baseUrl`-style keys are detected in `settings.json`, show a one-time `"Export to YAML & clear" | "Dismiss"` notice. "Export" converts the flat keys to a `.champ/config.yaml` and clears the settings keys; carried in the same tickets as a small command + tests.

---

## 3. Design: Workstream B — Context-Window Truth

### 3.1 Context-window reconciliation: the source of truth

A single pure function resolves a model's *effective served* context window from the richest available metadata. All consumers read from it.

```
 resolveEffectiveContextWindow(metadata) → number

 priority ladder (first hit wins):
   1. runtime parameter    parameters.num_ctx            // what the running
   2. runtime modelfile    modelfile::num_ctx           // instance actually serves
   3. show-response        show.{max_context_length, context_length}
   4. tags details         tag.details.context_length
   5. model_info           model_info["*.context_length"]
   6. fallback             provider-specific default (e.g. 8192)
```

```
FACTS:
  advertised (theory)   = model_info schémata *.context_length   e.g. 262144
  served (runtime)      = parameters.num_ctx                     e.g.  16384
  ─────────────────────────────────────────────────────────────────────────
  Champ today            budgets 75% × 262144 = 196608   ❌ exceeds 16384
  Champ after (B)        input ≤ 16384 − outputReserve   ✅
```

### 3.2 Where it is wired

```
                 ┌──────────────────────────────────────────────────────┐
                 │  Discovery (before)          Discovery (after)       │
                 │  listModels → id/name        listModels + hydrate    │
                 │  fallback /api/tags          /api/tags w/ details    │
                 │  fixed 8192/4096             ladder → real window    │
                 └──────────────────────────────────────────────────────┘
                                            │
                                            ▼
                 ┌──────────────────────────────────────────────────────┐
                 │  modelInfo().contextWindow  = resolved served window │
                 │  providers.<id>.contextWindow (persisted in YAML)    │
                 └──────────────────────────────────────────────────────┘
                                            │
        ┌───────────────┬───────────────────┴────────────┐
        ▼               ▼                                ▼
   context-manager   provider.trimForContext        team-agent
   (agent budget)    (per-request trimming)         (team token budget)
```

- **Provider layer.** The `modelInfo()` calls that currently return `8192`/`4096` hardcodes read the resolved value.
- **Smart-router discovery.** The `/api/tags` and `/v1/models` discovery paths populate `contextWindow` from the resolved ladder instead of constants.
- **Persistence.** The wizard (Workstream A) writes the resolved `contextWindow` into `providers.<id>.contextWindow` so it survives across sessions without re-probing. Config schema gains the field.
- **Budget math.** `context-manager.ts` already reserves `min(4096, window/2)` for output and fires compaction at overflow — with a truthful window this becomes correct for free. `trimForContext` in each provider (currently `0.75 × window` heuristic) is replaced by an explicit `input ≤ window − outputReserve` expression via the manager.

### 3.3 Tests required

- Ladder resolution: num_ctx beats context_length; modelfile beats model_info; unknown → fallback.
- Systems with a *served* window smaller than *advertised* never produce a budget above served.
- Discovery repopulates `contextWindow` on models that were previously mis-typed `8192`.
- YAML round-trip preserves a persisted `contextWindow`.

---

## 4. Design: Workstream C — Decode Parameter Profiles

### 4.1 Default profile per task class

The smart router already classifies models (`coding` / `instruct` / `general` / `embedding`) and routes per task (autocomplete / chat / agent). Attach a decode profile to (task × model-class):

| task | temperature | top_p | top_k | seed | notes |
|---|---|---|---|---|---|
| tool-call / agent turn | 0.1–0.2 | 0.90 | – | fixed | deterministic tool use |
| code generation | 0.2–0.4 | 0.95 | low | – | lower repeat penalty |
| chat / explain | 0.70 | 0.90 | – | – | today's default |
| autocomplete (FIM) | 0.20 | 0.90 | – | fixed | determinism, low TTFT |

### 4.2 Type + plumbing changes

```
ChatOptions  (types.ts)  + topK, minP, repeatPenalty, presencePenalty,
                          frequencyPenalty, seed, stop, numPredict
CompleteOptions           + topP, topK, seed, presencePenalty,
                          frequencyPenalty, stop
LLMProviderConfig         + decode profile object (profileId | partial overrides)
```

Backend field mapping (each provider maps `ChatOptions` → its native body):

| option | backend A (native) | OpenAI-compatible | /props family |
|---|---|---|---|
| temperature | native `options.temperature` | `temperature` | `temperature` |
| top_p | native `options.top_p` | `top_p` | `top_p` |
| top_k | native `options.top_k` | `top_k` | `top_k` |
| min_p | native `options.min_p` | (v7 payload) `min_p` | (server payload) |
| repeat_penalty | native `options.repeat_penalty` | – | `repeat_penalty` |
| presence/frequency | – | `presence_penalty` / `frequency_penalty` | `presence_penalty` / `frequency_penalty` |
| seed | native `options.seed` | `seed` | `seed` |
| max tokens | native `options.num_predict` | `max_tokens` | `n_predict` |
| stop | native `options.stop` | `stop` | `stop` |

Priority for a request's effective params: **explicit per-request override > task-profile default > config-provider `options` block > built-in default**.

### 4.3 YAML surface

```yaml
providers:
  llama-compatible-server:
    baseUrl: http://192.168.1.40:8000/v1
    model: code-model-7b
    options:
      temperature: 0.25
      topP: 0.95
      seed: 42
```

Overrides win over the task profile. Schema validation added for the `options.*` block (types + bounds) so a typo surfaces at load time, not at request time.

### 4.4 Tests required

- Profile resolver: task × class → expected params; explicit override wins.
- Provider field mapping: each backend receives the mapped names (spy on request bodies via mocked fetch).
- Config schema rejects out-of-range `options.*` (e.g. `temperature > 2`).

---

## 5. Design: Workstream D — Prefill & Structured Output

### 5.1 Assistant-prefill for tool calls

Today the prompt-based tool path detects *narrated-but-never-executed* tool calls after the fact and forces a `tool_call` re-emit. Prefill fixes the cause: seed the assistant turn's first tokens so the model starts generating inside the tool-call format.

```
Before (prompt-only, reactive)
  user: find all TODOs in src/
  assistant: Sure! Let me look at that. First I will search…   ← narration,
        [no tool_call]                                           then guard and retry

After (assistant-prefill, pre-emptive)
  user: find all TODOs in src/
  assistant: <tool_call prefix>                                  ← starts correct
        tool_call{name:"search_files", args:{...}}                 first token
```

Design: at the start of an agent orchestration turn, if the backend uses prompt-based tools, append the assistant-prefill token(s) as the *first* assistant message content of the new turn (then stream the rest). Cost: deterministic tool calling, lower TTFB on the follow-up, no wasted narration turn. For OpenAI-compatible backends that support `continue_final_message`-style semantics this can be achieved by seeding the assistant prefix in the request.

### 5.2 Stable prefix for KV/prompt-cache reuse

Local backends auto-cache (or, when enabled, cache) the KV state of a repeated prefix. Multi-turn agent loops hit that cache only if the prefix is **byte-identical** across turns. Changes:

1. Freeze assembly order: `system` → static tool definitions (constant serialization, never randomized JSON key order) → conversation.
2. Never re-serialize the same system/tool block differently between turns.
3. Explicitly toggle cache reuse where the backend exposes it (send the cache/CUDA-graph-friendly flag on the first request; rely on default for subsequent).

Measurable target: turn N of a 10-turn loop re-prefills only the delta (system + tools serve from cache after turn 1).

### 5.3 Structured output (grammar / JSON-schema-constrained generation)

For backends with native structured-output support, force the tool-call result to match a schema *while generating*, making malformed calls impossible:

| backend | mechanism |
|---|---|
| native (local inference) | per-call `format: json` + grammar or JSON-schema constrained decode |
| OpenAI-compatible | `response_format: {type: "json_object"}` / guided JSON (server feature) |
| /props family | JSON-schema grammar; `cache_prompt` on |

Wire the tool-call schema (already available in `ToolParameterSchema`) into the constrained-decode path when the active backend advertises support. Fall back to the existing XML prompt parser otherwise (unchanged).

### 5.4 Tests required

- Prefill: agent turn emits the tool prefix as the first assistant content; no narration precedes it.
- Prefix stability: two turns with identical system+tools produce byte-identical assembled prompt prefixes.
- Structured output: constrained path sends the correct `format`/`response_format`; unmocked fallback still parses XML tools.
- KV-cache toggle: correct flag on first request, absent thereafter where required.

---

## 6. End-to-end data flow (post-change)

```
 New user
   │  first-run
   ▼
 [onboarding wizard] ──────────────────────────────────────────────┐
   │ provider │ endpoint │ key │ auto-detect models │ scan models │
   ▼                                                            │
 device host servers ── probe/ladder ──▶ model metadata ────────┼─▶ persisted
   (local endpoints,                                           │   .champ/config.yaml
    cloud APIs)                                                 │   { provider, providers.*,
   │  runtime num_ctx ●  model list ●  capabilities            │     options, contextWindow }
   ▼                                                            │
 [provider factory]──SecretStorage keys─────────────────────────┤
   │                                                            │
   ▼                                                            │
 [smart router]  task decode profile + effective contextWindow  │
   │   tool-call: temp 0.1, seed fixed                          │
   │   code:      temp 0.3                                       │
   │   chat:      temp 0.7                                       │
   ▼                                                            │
 [agent orchestrator] context budget = window − outputReserve    │
   │   trim / compact → fit budget ▲                             │
   ▼                                                            │
 [provider request]  stable prefix + prefill + optional grammar  │
   │   native options mapped per backend                         │
   ▼                                                            │
 [backend]  KV-cache reuse across turns · constrained decode     │
   │   usage {input, output} → calibrated token estimator        │
   ▼                                                            │
 [tool registry]  schema-validated execution → audit log         │
```

---

## 7. Compatibility & migration

| Concern | Resolution |
|---|---|
| Existing `champ.*` settings users | One-time export-to-YAML notice (Workstream A) |
| Existing working `.champ/config.yaml` | Unchanged; wizard merges, never clobbers |
| Prompt-based XML tool fallback | Remains as the fallback under D; no behavioural regression |
| `champ.configSource = settings` semantics | Deleted with the settings layer |
| Provider `openai-compatible` for exotic endpoints | Unchanged, still the escape hatch for anything custom (incl. Apple-Silicon / AMD backends) |

---

## 8. Non-goals

- No new provider *types* (Apple-Silicon / AMD-specific engines are out of scope; they already work through the generic OpenAI-compatible adapter).
- No webview settings rewrite — the wizard is native QuickPick/InputBox.
- No change to the agent loop, approval flow, RAG indexing, or checkpoint behaviour except where context/decoding touches them.

---

## 9. Rollout & validation

1. **Per-ticket TDD**: failing unit tests written first, implementing to green.
2. **Per-ticket commit**: each workstream lands as one commit (independent of PR granularity).
3. **Gate**: `pnpm run check-types && pnpm run lint && pnpm run test:unit` (the merge gate). Integration/e2e suite run by the maintainer before merge.
4. **Manual smoke** (maintainer): wizard happy path, 401 key flow, offline-server fallback, existing config preserved.
5. **Release**: v1.8.0.

---

## 10. Task breakdown → tickets

| # | Ticket (title) | Workstream | Tests required (checklist inside ticket) |
|---|---|---|---|
| 1 | Guided provider setup wizard + YAML-only config | A | yaml-writer merge; wizard scope/provider/key/model decisions; settings-layer deletion; export-notice |
| 2 | Runtime context-window truth (served `num_ctx`) | B | ladder resolver; budget never exceeds served window; discovery repopulates; YAML persistence |
| 3 | Task-aware decode profiles + per-provider options | C | profile resolver; backend field mapping; options schema validation |
| 4 | Prefill & structured output (tool-call correctness) | D | assistant-prefill; prefix stability; constrained decode; KV-cache toggle |