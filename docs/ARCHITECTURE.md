# Champ Architecture

Single technical architecture reference for the **Champ VS Code extension** (`dist/extension.js`), **webview** (`webview-ui/`), and **headless CLI** (`dist/cli.js`).

## Index

1. [High-Level Architecture](#high-level-architecture)
2. [Module Map](#module-map)
3. [Agent Loop & Context Engine](#agent-loop--context-engine)
4. [Hallucination Mitigation](#hallucination-mitigation)
5. [Provider Registry, Credentials & Smart Routing](#provider-registry-credentials--smart-routing)
6. [CLI Packaging & SEA Evaluation](#cli-packaging--sea-evaluation)
7. [Multi-Agent Orchestration & Teams](#multi-agent-orchestration--teams)
8. [Codebase Indexing, Checkpoints & Safety](#codebase-indexing-checkpoints--safety)
9. [Observability & Performance Optimizations](#observability--performance-optimizations)

---

## High-Level Architecture

```
┌─────────────────────────── VS Code Extension Host (src/extension.ts) ───────────────────────────┐
│ ChatViewProvider ──▶ AgentController ──┬─▶ ToolRegistry (19 tools + approval + CommandSandbox)  │
│ InlineCompletion     SmartRouter       ├─▶ IndexingService (AST chunking + vector store + cache)│
│ DiffOverlay          EndpointRegistry  ├─▶ MultiAgentRunner / Orchestrator / TeamRunner          │
│ AgentManager         CheckpointManager └─▶ Safety (PromptGuard, SecretScanner, PiiScanner, Audit)│
└───────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                        │ postMessage (discriminated union: src/ui/messages.ts)
                                        ▼
                        Webview UI (webview-ui/static + Preact panels)

┌─────────────────────────── Headless CLI (src/cli.ts → dist/cli.js) ─────────────────────────────┐
│ parseCliArgs ──▶ Command Dispatch (setup/provider/models/config) OR AgentController             │
│                  EndpointRegistry (providers.json + OS keyring/env) + Headless fs ToolRegistry  │
│                  CliRules + CliSkills + AppliedToolScope + Append-only JSONL SessionLog         │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Module Map

| Area | Directory / Entry | Key Responsibility |
|---|---|---|
| Host entries | `src/extension.ts`, `src/cli.ts` | VS Code activation (lazy-loaded panels/runners) and standalone CLI (`vscode`-free) |
| Config & Registry | `src/config/` | `EndpointRepository`, `EndpointRegistry`, `CredentialStore`, `model-discovery`, `ConfigLoader`, `ConfigWatcher`, `runWizard`, `migrateFromYaml` |
| Providers & Routing | `src/providers/` | `LLMProvider` adapters (`Claude`, `OpenAI`, `Gemini`, `Ollama`, `LlamaCpp`, `VLLM`, `OpenAICompatible`), `ProviderFactory`, `SmartRouter`, `CircuitBreaker`, `FallbackProvider`, `RateLimitedProvider`, `resilientFetch`, `ContextManager`, `ContextSummariser`, `ResponseCache` |
| Agent & Prompts | `src/agent/`, `src/prompts/` | `AgentController`, `ToolCallingLoop`, `MultiAgentRunner`, `AgentOrchestrator`, `TeamRunner`, `DelegationManager`, `SharedMemory`, `SystemPromptBuilder`, `EditReviewTracker` |
| Tools & SSH | `src/tools/`, `src/ssh/` | Built-in tools, `headless/` FS tools, `bounded-read`, `git/`, SSH connection pool & MITM trust |
| Indexing & Memory | `src/indexing/`, `src/memory/` | `ChunkingService`, `EmbeddingService` (content-hash cache), `VectorStore`, `RepoMapBuilder`, `MemoryBank` |
| Rules, Skills & Sessions | `src/rules/`, `src/skills/`, `src/session/` | Markdown rules/skills loaders, `VariableResolver`, append-only JSONL `SessionLog` |
| Safety | `src/safety/` | `SecretScanner`, `PiiScanner`, `PromptGuard`, `CommandSandbox`, `AuditLog` (hash-chained) |
| Observability & UI | `src/observability/`, `src/telemetry/`, `src/server/`, `src/ui/` | `MetricsCollector`, `AgentAnalytics`, `AnalyticsExporter`, `ChampServer` (`/health`, `/metrics`, `/chat`, `/run-team`), `ChatViewProvider`, `DiffOverlayController` |

---

## Agent Loop & Context Engine

1. **Ingress**: `AgentController.processMessage` runs `PromptGuard` + `PiiScanner` on input, selects model via `SmartRouter` (or CLI/registry selection), filters tools by mode (`ask`/`plan` = read-only), and prepends `RepoMapBuilder` workspace outline on the first turn.
2. **Iteration Loop** (bounded by `maxIterations`, default 25):
   - Checks `AbortSignal` and yields cleanly; only flushes `stagedEdits` when not aborted.
   - Fits messages via `ContextManager` + `ContextSummariser` (provider-anchored token accounting; summaries persisted; `atomicGroups` keeps native `tool_use`/`tool_result` and prompt-based `<tool_call>`/`<tool_result>` pairs intact; clamps oversized tool outputs symmetrically while preserving `<tool_result>` wrappers).
   - Consults `ResponseCache` (SHA256 of messages + tools, first iteration only).
   - Executes read-only tool calls in parallel (`Promise.allSettled`) and mutating calls sequentially after approval; truncates large outputs (`<=3000` chars) and reads files via bounded 2 MB slices (`src/utils/bounded-read.ts`).
   - Screens tool outputs with `SecretScanner` and `PromptGuard`.
3. **CLI Sessions (`src/session/session-log.ts`)**: JSONL append-only logs under `<workspace>/.champ/sessions/`. Resumes bound replay at the newest `/checkpoint` (preserving its summary); `/compact` rewrites atomically; torn headers trigger explicit recovery hints.
4. **CLI Skills & Rules (`src/cli/skills.ts`, `rules.ts`, `tool-scope.ts`)**: Invalid `.champ/skills/*.md` or `.champ/rules/*.md` emit stderr warnings and skip rather than aborting. Skills with `allowedTools` scope `ToolRegistry` and guarantee `restore()` in `finally`.

---

## Hallucination Mitigation

1. **Hardened System Prompts (`SystemPromptBuilder`)**: mandatory tool-use directives, verify-before-claim rules, and wrong/right few-shot examples.
2. **Repo Map Grounding (`RepoMapBuilder`)**: extracts workspace top-level files + function/class signatures (~8K token cap, invalidated on file change) so the model uses real identifiers.
3. **Read-Before-Edit Enforcement (`AgentController`)**: tracks `filesReadThisSession` and auto-injects `read_file` before `edit_file` on unread files.
4. **Verbose Actionable Errors (`src/utils/edit-match.ts`)**: failed `edit_file` returns numbered actual file lines (up to 80) so the model self-corrects cleanly.
5. **Fabricated-Narration Guard (`hasFabricatedNarration`)**: detects fake narration markers (`> Reading...`, `---Result of`) when no tool call was emitted and injects a corrective turn.
6. **JSON Schema Tool Validation & Auto-Fix (`AutoFixService`)**: validates tool call arguments against schema before execution and optionally re-prompts on new LSP diagnostics (up to 3 iterations).

---

## Provider Registry, Credentials & Smart Routing

### Endpoint Registry (`~/.champ/providers.json`)

- **Model**: `ProviderKind → Endpoint → DiscoveredModel[] → TaskAssignment` (`default | coding | chat | completion | embedding`). Workspace overrides live in non-secret `<workspace>/.champ/provider.json`.
- **Safety & Concurrency**: `EndpointRepository` writes atomically (`tmp` → `fsync` → `chmod 0600` → `rename`), refuses symlinks (`lstat`), skips malformed endpoints with warnings instead of losing the file, never writes secrets, and serializes writers via `mkdir` exclusive locks (30s stale detection, 5s timeout).
- **Credential Isolation**: `ChainCredentialStore` (CLI: macOS `security -i`, Linux `secret-tool store` via stdin — never `argv`, env fallback) and `VsCodeSecretCredentialStore` (`context.secrets`, structural interface with zero `vscode` import) share logical ref IDs (`champ.<provider>.apiKey` or `ep_<id>`).
- **Discovery & Health Probes**: `model-discovery.ts` reuses `buildProbeUrl` and `resilientFetch` (5s per-request timeout, 15s discovery / 10s test deadline, concurrency $\le 4$, Bearer auth supported, timeouts reported `ok: false`).

### Smart Router (`src/providers/smart-router.ts`)

- Scans configured backends in parallel (3s timeout per provider, non-blocking after activation), classifies models via pure CPU heuristics (`coding`, `embedding`, `instruct`, `general`, `fast`/`medium`/`slow`, size/context), and scores `coding | chat | completion | embedding` tasks in `<0.1 ms` while honoring manual locks and routing overrides.
- Wraps providers with `resilientFetch` (backoff + `Retry-After`), `CircuitBreaker`, `FallbackProvider`, and `RateLimitedProvider`.

---

## CLI Packaging & SEA Evaluation

- `npm pack` uses `.npmignore` allow-list to ship 4 files (`package.json`, `README.md`, `LICENSE`, `dist/cli.js`), excluding repo internals and `.champ/`. `prepack` runs `node esbuild.mjs --production`.
- **Node 22 Single Executable Application (SEA) baseline measurements (2026-11-22, Node `v22.23.2` linux-x64)**:
  - `dist/cli.js` (`--production`): `392.1kb` (`393K` on disk)
  - Bare `node -e ""`: `0.02s` elapsed, `42,292 KB` (~41.3 MiB) max RSS
  - `node dist/cli.js provider list --cwd /tmp`: `0.09s`, `59,364 KB` (~58.0 MiB) max RSS
  - `node dist/cli.js --list-skills --cwd /tmp`: `0.10s`, `62,208 KB` (~60.8 MiB) max RSS
  - `node --experimental-sea-config` blob: `393K` (`node` binary itself is `120M`; `npm pack`/`npm link` remains primary to avoid 120 MiB per-host binary inflation).

---

## Multi-Agent Orchestration & Teams

- **`MultiAgentRunner`**: fixed pipeline (`planner → context → code → reviewer → validator`) with bounded `retryFrom` budget checks.
- **`AgentOrchestrator`**: sequential or conditional DAG (`condition`, `next`) over `SharedMemory`.
- **`TeamRunner`**: computes Kahn topological parallel batches (`Promise.all` up to `maxParallel`), enforces `totalTokenBudget` and timeouts, checkpoints completed agents (`checkpoint-<id>.json`) for resume, validates `json` outputs, supports `BLOCKED:` handling, `selfCritique`, and dynamic `SPAWN:` queuing (capped at 10).
- **`DelegationManager`**: routes delegated sub-tasks with timeouts and clean cancellation.

---

## Codebase Indexing, Checkpoints & Safety

- **Indexing (`src/indexing/`)**: TS/JS AST chunking + sliding windows (regex AST fallback; tree-sitter upgrade noted as future work), SHA256 embedding disk cache (`~/.champ/embed-cache/<model>.json`), HNSW (`hnswlib-node` >10K chunks) with brute-force cosine fallback, persisted index reuse, file-watcher incremental updates, and ripgrep lexical fallback.
- **Checkpoints (`src/checkpoints/`)**: content-addressed shadow-copy snapshots (`manifest.json` + hashed blobs) created before destructive edits; restorable independently of git.
- **Safety (`src/safety/`)**: `CommandSandbox` (blocklist + safe allowlist + timeout), `SecretScanner` (PEM/cloud/service tokens), `PiiScanner`, `PromptGuard` (inbound & tool-output screening), `utils/workspace-path.ts` (symlink-safe containment), and hash-chained `AuditLog` (`Champ: Verify Audit Log`).

---

## Observability & Performance Optimizations

- **`MetricsCollector` & `ChampServer`**: bounded metric ring buffers, Prometheus `/metrics`, `/health`, `/chat`, `/run-team` guarded by timing-safe bearer auth (`0600` token file).
- **`AnalyticsExporter`**: OTLP/JSON export respecting `vscode.env.isTelemetryEnabled`.
- **Webview & Host Latency**: lazy dynamic imports in `src/extension.ts`, rAF-batched streaming deltas, floating pickers, and shared `Map`-based router deduplication.
