# Multi-Persona Engineering Review — 2026-08-23

Reviewers: Principal Architect, Agentic-Systems Engineer, SRE, Observability/DevOps, RAG Engineer, Principal UI/UX, Performance Engineer.
Method: read-only source audit (5 parallel deep-dives) + knowledge-graph queries. All findings cite `file:line` verified this session. Repo state: branch `fix/hallucination-and-icons`, v1.6.169, 18 uncommitted changes.

---

## Verdict

Strong feature surface and several exemplary primitives (SecretStorage discipline, audit hash-chain, PromptGuard on input + tool outputs, strict TS protocol types). But there are **5 P0 defects** — two security, one safety, one correctness — plus a RAG pipeline that is structurally non-compliant with production RAG practice, and an agentic core missing the resilience layer (retry/backoff/cancel-safety) expected of an autonomous tool-executing agent.

---

## P0 — Fix before next release

| # | Finding | Evidence |
|---|---------|----------|
| P0-1 | **Published VSIX leaks user data + internals**: `.champ/team-runs/*/checkpoint-*.json` contain real user requests & names; ships 5.1MB `graphify-out/graph.json`, internal sprint plans, server logs. `.vscodeignore` misses `graphify-out/** .champ/** .superpowers/** docs/** *.md pnpm-lock.yaml`. Source `.champ/team-runs` is also git-tracked (36 files). | `.vscodeignore:1-36`; vsix listing of champ-1.6.169 |
| P0-2 | **Shell injection into `execSync` via LLM-controlled git args**: `git log ${baseBranch}` raw (:124); `git add` double-quote breakout (:170); `commit -m` escapes quotes but not backticks/`$()` (:192). Only mitigation is the preview string, itself unsanitized (:85). | `src/tools/git/git-utils.ts:124,170,192` |
| P0-3 | **Approval system bypassed**: `@champ` chat participant passes `requestApproval: async () => true` — every destructive tool auto-runs; same in validator-agent. Meanwhile `champ.yoloMode` is written to settings but never read anywhere — the documented kill-switch is inert in chat path. | `extension.ts:1150-1153`; `validator-agent.ts:46`; `chat-view-provider.ts:495-498` |
| P0-4 | **Cancel does not roll back staged edits**: `stagedEdits.flush()` runs unconditionally after loop, including when abort broke out mid-turn — user-cancelled turns still write files. | `agent-controller.ts:962-973` |
| P0-5 | **Unbounded loop via mutual `retryFrom`**: failure handler resets target's attempt counter (`attempts.set(branchTarget, 0)`); two agents retrying each other zero counters forever → infinite LLM burn. Same pattern in AgentOrchestrator. | `multi-agent-runner.ts:230-242, 629-638` |

## HIGH

| # | Finding | Evidence |
|---|---------|----------|
| H-1 | No HTTP timeout or retry/backoff on provider hot path — hung Ollama/vLLM socket stalls stream forever (`abortSignal` is user-cancel only); no 429 handling; RateLimiter *throws* instead of waiting; main loop returns immediately on mid-stream error, no backoff. | `openai-compatible.ts:154-159`; `ollama.ts:240,297`; `rate-limiter.ts:45-54`; `agent-controller.ts:712-742` |
| H-2 | Context compaction recomputed every iteration from full history (extra LLM summarize call per iteration), summaries never persisted back; dropping "oldest middle" can split `tool_use`/`tool_result` pairs → hard API error on Anthropic-style providers. | `agent-controller.ts:577-637`; `context-manager.ts:71-113` |
| H-3 | Full untruncated tool results into team-loop history; that loop has MAX_ITERATIONS=4 and **no context fitting at all**. | `tool-calling-loop.ts:284-289, 47-52` |
| H-4 | Malformed tool-call JSON silently dropped (`catch { continue }`) and args never validated against tool JSON schema — model gets no feedback; invalid args reach tools unchecked. | `prompt-based-tools.ts:141-165`; `registry.ts:44-80` |
| H-5 | Index is write-only: disk index saved every session but never loaded (`tryLoadIndex` dead code); no FileSystemWatcher on sources → index stale immediately after any save; `reindexFile`/`invalidateIndex` dead. Every activation = full re-walk. | `indexing-service.ts:136,258,235` |
| H-6 | Observability is console-only (100+ raw console.* calls), MetricsCollector arrays grow unbounded all session, error paths hardcode zero token usage, no `/metrics` endpoint on champ-server. | `metrics-collector.ts:56-61`; `openai.ts:97`; `champ-server.ts:104-111` |
| H-7 | `OSLevelSandbox` (bwrap/seccomp, 486 lines) is dead code; actual terminal path uses denylist `CommandSandbox` whose own header admits it cannot prevent exfiltration; child processes inherit full `process.env`. | `os-level-sandbox.ts` (zero importers); `command-sandbox.ts:8-14`; `run-terminal.ts:82` |
| H-8 | Browser tool lacks the SSRF guard fetch-url has — accepts `file://`, localhost, link-local. | `browser.ts:64-71` vs `fetch-url.ts:59-80` |
| H-9 | Streaming render O(n²): every delta triggers full-message `innerHTML` markdown re-render + hljs re-highlight of ALL blocks + document-wide querySelector; zero throttle/debounce/rAF; highlight.js 1.08MB eagerly loaded per chat open; no virtualization for long chats. | `main.js:1660-1680,2221-2222`; `chat-view-provider.ts:1433-1474` |
| H-10 | Dual lockfiles + npm/pnpm contradiction: both locks tracked, `packageManager: pnpm@10.29.3` uncommitted, all scripts + husky + CI use npm/npx against npm lockfile currently being modified. | `package.json:414-471`; `ci.yml:20,33,46` |
| H-11 | DelegationManager: timeout timer never cleared, timed-out executions keep running (no AbortSignal in SubAgent contract), retry can start attempt N+1 while N runs; tasks/logs Maps grow until dispose. | `delegation-manager.ts:337-341, 109-229`; `types.ts:93-97` |

## MEDIUM (selected)

- **God-file monolith**: extension.ts = 4,496 lines, ~20 concern domains wired inside one `activate()` closure, 53 inline command registrations, **27 module-level mutable singletons**, audit middleware installed by monkey-patching `toolRegistry.execute` (:214-223).
- **Deactivate leaks**: smartRouter-held providers, fallback-chain members, AgentManager, SessionStore, persistentRunner never disposed; ChatViewProvider listener nulled without invoke (`extension.ts:4172-4200`). 11 empty/comment-only catch blocks across critical paths.
- **Config merge gaps**: workspace `triggers:` silently dropped when user config exists; `mcp.servers` replaced not merged; unknown top-level keys discarded without warning; only first YAML validation error surfaces. Plaintext secrets still enter via SSH passwords/self-hosted keys/telemetry headers; MCP marketplace env inputs unmasked.
- **Webview protocol typing bypassed** with 10× `as never` sends of unregistered message shapes (`extension.ts:1334,2204`; `chat-view-provider.ts:221,609,773`).
- **Ext-host thread blockers**: 13 execSync + 4 spawnSync incl. `rg` up to 10s block (`codebase-search.ts:79`), gh PR/issue calls in context resolution (`context-resolver.ts:623-691`), LCS diff allocates ~32MB DP table for 2k-line files synchronously (`diff-overlay-controller.ts:66-98`).
- **UX bugs**: live AgentGraph edges never drawn (empty dependsOnMap, `AgentGraphPanel.tsx:473-476`); hunk partial-accept shows stale buffer until last hunk resolved; RulesEditorPanel module-level listener leak; TeamBuilder drag clones entire Map per pointermove (no rAF); a11y ≈ zero (3 aria-labels / ~2,700 LOC, no keyboard nav, no focus traps).
- **Release process**: CHANGELOG last entry 1.6.5 (2026-04-27) vs v1.6.169; version bumps manual+uncommitted; zero publish automation; `run-e2e.sh` swallows failures under `set -e` → red suite exits green; CI has no build/package gate.
- **Test gaps**: `utils/workspace-path.ts` (the path-traversal guard) untested; integration suite = 1 file; extension.ts excluded from coverage; ResponseCache key mismatch bug in ToolCallingLoop (store key `"tool-loop"` ≠ lookup key `provider.name` — entries unreadable).
- **Repo hygiene**: 64 vsix artifacts (~50MB) in root; graphify-out/ fully git-tracked (churns every update); pending-items.md untracked.

## What's good (calibration)

Strict TS everywhere except entry file; `messages.ts` clean discriminated union; cloud API keys forced to SecretStorage and YAML keys rejected; AuditLog hash-chain w/ verify + OOM guard; PromptGuard applied to inbound text AND outbound tool outputs; circuit breaker + fallback chain tested; timing-safe bearer compare + 0600 token file; startup mostly backgrounded with 5s race; bounded response cache/session store/terminal buffer; solid CSP in main chat view.

---

## Agentic Workload — How It Works Today

```
 ┌──────────────┐ postMessage ┌──────────────────┐
 │ Chat Webview │────────────▶│ ChatViewProvider │ (91 message types)
 └──────────────┘             └────────┬─────────┘
                                       │ processMessage()
                                       ▼
        ┌────────────────── AGENT TURN (agent-controller.ts) ──────────────────┐
        │ queue if busy → SmartRouter.select() → PromptGuard(in) → PII redact  │
        │ → history append → tools filtered by mode (ask/plan = READ_ONLY)     │
        │                                                                      │
        │ ITERATION LOOP (max 25):                                             │
        │   ├─ abort check + setImmediate yield                                │
        │   ├─ build msgs (+XML tool catalog | grounding sysprompt)            │
        │   ├─ fitWithSummary: drop oldest middles + LLM-summarize             │
        │   │    ⚠ NOT persisted → recomputed EVERY iteration                  │
        │   ├─ ResponseCache? (iteration 0 only)                               │
        │   ├─ LLM STREAM ──┬─ native: live deltas                               │
        │   │               └─ prompt-based: buffered → parse <tool_call> XML  │
        │   │                     ⚠ malformed JSON dropped silently            │
        │   │                     ⚠ narration guard → corrective turn → retry  │
        │   ├─ no tools? → done                                                │
        │   └─ TOOLS (sequential): approval? → execute → SecretScanner +       │
        │        PromptGuard(out) → result→history                             │
        │        ⚠ args NOT schema-validated ⚠ no per-tool timeout default     │
        └──────────────────────────────────────────────────────────────────────┘
                     │                                    ▲
          stagedEdits.flush()                abort signal checked between
          ⚠ flushes EVEN WHEN ABORTED        steps, not inside delta loop
                     ▼
        analytics finalize → memoryBank store
```

Orchestration layers above it:

```
 MultiAgentRunner: planner→context→code→reviewer→validator (fixed pipeline,
                   sequential) ── retryFrom jumps cursor, resets counter ⚠ mutual
                   retryFrom = infinite ping-pong ── no persistence/resume

 AgentOrchestrator: sequence | DAG with per-node condition skip + dynamic routing

 TeamRunner: Kahn topological groups → parallel batches (Promise.all) → SharedMemory
             Maps + pub/sub (busy-poll subscribe ⚠) → budgets checked BETWEEN groups
             only ⚠ → checkpoints on SUCCESS only ⚠ (failed work unrecoverable)
             → resume supported → dynamic SPAWN (cap 10)

 DelegationManager: least-loaded pick, retries ×3, 30s timeout
                    ⚠ timer leak, zombie executions, no cancellation

 WorkerBridge: spec-only interface (Phase-6 "champd" worker isolation) — not built;
               everything runs on the extension host today
```

## RAG Compliance Scorecard

| Practice | Status | Note |
|---|---|---|
| Git-aware collection | ✗ | Not .gitignore-aware; regex ignore has unescaped dots; no size cap; no binary sniff |
| AST chunking | Partial | TS/JS only; Python/Go/Rust get blind 100-line windows |
| Batched embeddings | ✗ | Sequential per-chunk loop; OpenAI path sends one string/request |
| Incremental updates | ✗ | Watcher absent; reindexFile dead code; full rebuild each activation |
| Persistent index reuse | ✗ | Disk index written, never read back |
| Vector store hygiene | Partial | L2 labeled cosine; unnormalized → threshold arbitrary; silent dim truncation |
| Hybrid retrieval (BM25+vector) | ✗ | rg only as fallback when index missing, never fused |
| Reranking | ✗ | Absent |
| Token budgeting of retrieved context | ✗ | @Codebase injects 8 untruncated chunks |
| Dedup overlapping chunks | ✗ | Sliding windows overlap 20 lines, no IoU/MMR dedupe |
| Retrieval telemetry | ✗ | No hit-rate/recall instrumentation |
| Cross-window concurrency | ✗ | Same index file, last-writer-wins, no lock/atomic rename |

---

## Roadmap to "Awesome" (ranked, effort-tagged)

### Wave 1 — Safety & correctness (week 1–2)
1. [P0] Fix `.vscodeignore`, untrack `.champ/team-runs`, purge graphify-out from package (S)
2. [P0] Parameterize git-utils exec → array-spawn, no shell interpolation (S)
3. [P0] Wire yoloMode into approval callback; remove `async () => true` bypasses (S)
4. [P0] Gate `stagedEdits.flush()` behind abort check + user confirm on cancel (S)
5. [P0] Cap total retries globally (retry budget per run) in multi-agent runner/orchestrator (S)
6. Provider HTTP hardening: connect+first-token timeout, bounded retry w/ exp backoff+jitter, honor Retry-After (M)
7. JSON-schema validate tool args pre-execute; feed validation errors back to model (M)

### Wave 2 — Agentic core upgrade (weeks 3–6)
8. Context memory manager: persist compaction, pair-preserving truncation, per-tool-result truncation w/ overflow-to-file pointers (L)
9. Parallelize: read-only tool fan-out (pattern already in ToolCallingLoop), concurrent context resolution (M)
10. Event-sourced run journal → pause/resume everywhere; checkpoint failures too (M)
11. Implement WorkerBridge spec: move diffing/indexing/tokenization off ext host (L)
12. Wire OSLevelSandbox into run-terminal (env scrubbing + bwrap when available) or delete it (M)

### Wave 3 — RAG compliance (weeks 4–8, parallelizable)
13. File watcher + incremental reindex + load persisted index (S, huge win)
14. Hybrid retrieval + RRF fusion; rerank top-20→top-8; IoU dedupe; token-budgeted packing (L)
15. Normalize vectors / explicit cosine; dim-checked store; atomic cross-window locked persistence (S)
16. Batched embeddings (`input[]`); tree-sitter chunking for py/go/rs (M/L)
17. Retrieval telemetry: latency, score distribution, accepted-edit correlation → tune thresholds (M)

### Wave 4 — Platform health (background)
18. Split extension.ts into feature modules (commands/, providers-wiring, mcp-wiring…); dispose graph completeness (L)
19. Single lockfile: delete package-lock.json, convert scripts/husky/CI to pnpm (S)
20. Observability: structured logger w/ trace IDs, capped metrics buffers, `/metrics` endpoint, OTLP export parity (M)
21. Stream rendering: rAF-batched delta application, trailing-block-only re-render, lazy hljs load, virtualization (M)
22. A11y pass + AgentGraph edges fix + CSP parity in workflow-panel (M)
23. Release automation: changelog generation, tagged versions, publish script, CI package gate; make e2e script fail loudly (M)
