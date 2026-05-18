# Champ — Platform Roadmap & Implementation Proposal

> **Status:** Proposal only. No implementation has started. This document covers:
> 1. All pending features organized into 6 phases
> 2. The review protocol between phases
> 3. A platform-level architecture proposal for moving beyond the VS Code extension model

> **Target audience:** Developers running Champ on their own laptops. This is the primary deployment model. Laptop execution is not a limitation — it is the design target. The champd daemon runs locally on the developer's machine (no cloud required), giving background execution and multi-window sharing without any infrastructure cost or data leaving the machine.

> **Competitive context:** Champ does not attempt to beat cloud-first platforms at autocomplete quality or UX polish in the general market. The strategic target is the segment those platforms structurally cannot serve: local-first, privacy-preserving, programmable AI development workflows for developers who want full control over their tooling.

---

## Part I — Phased Feature Roadmap

Each phase produces working, tested, audited software. The review protocol (Section II) runs after every phase before work on the next begins.

---

### Phase 1 — Baseline Polish
**Theme:** High-visibility, low-effort gaps that affect every daily user.
**Estimated scope:** 8–10 days of implementation.

| Feature | Gap It Closes | Effort |
|---|---|---|
| Copy button on every code block | No way to copy AI-generated code without selecting text | 0.5 day |
| Response regeneration button | Cannot re-run the same prompt with a different result | 1 day |
| Suggested follow-ups (3 per response) | Conversation dead-ends; users don't know what to ask next | 1.5 days |
| Conversation search (keyword within session history) | Sessions accumulate with no way to find prior answers | 2 days |
| FIM suffix context for inline autocomplete | Autocomplete quality degrades without what-comes-after context | 0.5 day |
| Bundled highlight.js (remove CDN dependency) | Offline environments fail; supply-chain surface | 0.5 day |
| Per-agent cost display in Timeline tab | Cost data exists but not shown at agent granularity | 0.5 day |
| In-webview settings panel (Phase 1: provider + model only) | Changing provider requires editing settings.json | 2 days |
| Response-acceptance telemetry for autocomplete | No feedback loop to improve model routing quality | 1 day |

**Review gate after Phase 1:** Run full internal review (type safety, test coverage, bundle size) + external audit focused on UX regression and performance.

---

### Phase 2 — Intelligence Upgrade
**Theme:** Richer context understanding, smarter routing, deeper editor integration.
**Estimated scope:** 14–18 days.

| Feature | Gap It Closes | Effort |
|---|---|---|
| `@PR(number)` and `@Issue(number)` GitHub context references | Cannot reference open PRs or issues in conversation | 3 days |
| `@Terminal` — auto-inject last terminal output | Cannot ask "why did my last command fail?" without copy-paste | 2 days |
| `@GitBlame(file)` — author + commit history as context | No author-aware context for code review workflows | 1.5 days |
| `@TestFor(function)` — generate test suite for a symbol | No direct path from function → test file | 2 days |
| User-defined model routing rules ("route TypeScript to X") | SmartRouter is internal; users cannot customize routing | 2.5 days |
| Workspace-wide rename/refactor with full preview tree | File edits are one-at-a-time; no atomic multi-file rename | 3 days |
| LLM response cache (TTL-based, opt-in) | Identical queries hit the API repeatedly at full cost | 2 days |
| Git auto-branch before multi-file agent edit | No rollback path if agent changes are wrong | 1.5 days |
| `@Notebook(cell)` — Jupyter notebook cell context | No notebook support | 2 days |

**Review gate after Phase 2:** Full internal review + external audit focused on context injection security (prompt injection via @PR content, @GitBlame content) and performance (cache correctness).

---

### Phase 3 — Agent Gateway Layer
**Theme:** Move from "agent runner inside extension host" to "agent gateway with proper isolation, concurrency, and observability."
**Estimated scope:** 20–25 days. This is the highest-impact phase.

| Feature | Gap It Closes | Effort |
|---|---|---|
| Worker thread execution — isolate agent loop from extension UI | Long agent runs stall TypeScript server and other extensions | 4 days |
| Multiple concurrent team runs (independent task queue) | Can only run one team at a time | 3 days |
| Per-agent cost attribution with cumulative display | Total cost only; cannot see which agent is expensive | 1.5 days |
| Agent stall detection + auto-retry (circuit breaker) | Hanging agents block the entire team indefinitely | 2 days |
| Background execution notification ("Team run completed") | No feedback when long-running team finishes | 1 day |
| Agent run exact replay (deterministic re-execution) | No way to reproduce a prior run for debugging | 3 days |
| Agent health dashboard (status, queue depth, cost rate) | No visibility into what agents are doing right now | 3 days |
| Rate limiter for LLM API calls (prevent cost runaway) | A misconfigured team can exhaust API budget in minutes | 2 days |
| Multiple active sessions (work on two tasks simultaneously) | Single active session only | 3 days |
| Provider fallback chains (if Claude fails, try OpenAI) | Single provider failure kills the entire run | 2 days |

**Review gate after Phase 3:** Full internal review + external audit focused on concurrency correctness, worker thread message protocol safety, rate limiter bypass scenarios, and cost attribution accuracy.

---

### Phase 4 — MCP Maturity
**Theme:** Complete the MCP story from client to a managed connection layer.
**Estimated scope:** 12–16 days.

| Feature | Gap It Closes | Effort |
|---|---|---|
| MCP sampling (servers can make LLM calls back through Champ) | Advanced agentic MCP servers cannot function | 3 days |
| MCP server process sandboxing (restricted env vars, no network by default) | MCP servers run with full user privileges | 4 days |
| MCP analytics panel (tool call latency, error rate per server/tool) | No visibility into MCP health or performance | 2.5 days |
| MCP server version pinning (lock to specific server version) | Server updates can silently break workflows | 2 days |
| Hot-reload MCP config without VS Code restart | Config changes require extension restart | 1.5 days |
| MCP connection pooling (reuse connections across requests) | New connection per request adds latency | 2 days |
| Team YAML content screening (scan prompts before execution) | Malicious workspace YAML can inject agent instructions | 2 days |

**Review gate after Phase 4:** Full internal review + external audit with specific focus on MCP sandboxing escape vectors, sampling loop security (infinite recursion), and YAML injection coverage.

---

### Phase 5 — Enterprise & Security Hardening
**Theme:** Make Champ safe for team and enterprise deployment.
**Estimated scope:** 16–20 days.

| Feature | Gap It Closes | Effort |
|---|---|---|
| CommandSandbox upgrade: seccomp profile option (Linux) or AppContainer (Windows) | Current sandbox is pattern-matching, not OS-enforced | 5 days |
| Audit log for all agent actions (file edits, terminal runs, LLM calls) | No tamper-evident record of what agents did | 3 days |
| Conversation export (JSON, Markdown, shareable link) | No way to share or archive conversations | 2 days |
| User-level memory bank (cross-workspace, persists across reinstall) | Memory is workspace-local and machine-local | 3 days |
| Team-shared rules and memory (shared `.champ/` for a team) | Rules and memory are per-developer | 2.5 days |
| Role-based tool permissions (read-only mode, no terminal for guests) | All users have identical capabilities | 3 days |
| API surface for external integration (webhooks, REST, CI/CD trigger) | Cannot trigger agent runs from GitHub Actions or CI | 4 days |

**Review gate after Phase 5:** Full internal review + external security-focused audit covering the audit log integrity, API authentication, OS sandbox coverage, and cross-workspace memory isolation.

---

### Phase 6 — Platform Foundation (Planning Phase)
**Theme:** Architectural transition from VS Code extension to platform. No code is written until Part II of this document is reviewed and a decision is made on the architecture option.

See Part III for the full platform architecture proposal.

---

## Part II — Review Protocol (After Every Phase)

Every phase ends with two mandatory gates before the next phase begins. No exceptions.

### Gate 1: Internal Code Review

Run immediately after all phase tasks are committed. Covers:

1. **Type safety sweep** — `npx tsc --noEmit` must produce zero errors
2. **Test coverage** — every new public method/function must have at least one failing-first test. Run full suite; no regressions allowed.
3. **Bundle impact** — run `npm run package` and compare bundle size to previous phase. Flag any increase over 10KB.
4. **Security self-check** — for each new user-facing input path, verify: is it sanitized? Is it validated? Is it logged to an audit trail?
5. **Dependency audit** — `npm audit` must show zero high/critical vulnerabilities.
6. **Dead code check** — grep for any TODO/FIXME/STUB introduced in the phase and resolve or document them.

**Output:** A written internal review report committed to `docs/reviews/YYYY-MM-DD-phase-N-internal.md`.

### Gate 2: External Audit

Run after Gate 1 passes. A fresh agent (no context from the implementation session) reads all diffs from the phase and produces a structured report covering:

- **Security:** injection vectors, privilege escalation, CSP violations, auth gaps
- **Bugs:** logic errors, race conditions, off-by-one, null dereferences
- **Code quality:** smells, dead code, misleading names, missing error handling
- **Performance:** unnecessary re-renders, sequential where parallel is possible, blocking the event loop
- **UX:** regressions in existing flows, new features that feel incomplete or inconsistent
- **Missing tests:** public surface with no test coverage

**Output:** A written audit report committed to `docs/audits/YYYY-MM-DD-phase-N-external.md`.

### Fix Cycle

All **Critical** and **Important** findings from the external audit are fixed before Phase N+1 begins. Minor findings are triaged: either fixed immediately or added to the Phase N+1 backlog with justification.

Fix commits reference the audit finding (e.g. `fix(security): approval gate for run-in-terminal [audit-C1]`).

After fixes are committed, a re-audit runs on only the changed files to confirm the findings are resolved. Only then does Phase N+1 begin.

---

## Part III — Platform-Level Architecture Proposal

This section proposes three options for moving beyond the VS Code extension model. The goal is to eliminate the hard ceilings described in the competitive audit: single-threaded execution, death-on-VS Code-close, no background agents, no cross-machine persistence.

**Decision required before Phase 6 begins.** The options are not compatible — choosing one forecloses the others in the medium term.

---

### Option A: Local Daemon Architecture *(Recommended — Primary Target)*

**Core idea:** Extract the agent execution layer into a persistent background service (`champd`) that runs on the developer's laptop independently of VS Code. The extension becomes a thin UI client that connects to the daemon. Laptop execution is the correct deployment model for a developer tool — developers are the users, they run this locally, no cloud needed.

**Why laptop execution is not a limitation here:** Cloud-first platforms struggle to serve developers who work offline, in air-gapped environments, on proprietary codebases, or who want zero data egress. champd on a developer's laptop solves background execution without any of those tradeoffs. A developer's laptop in 2026 (M-series Mac, Ryzen 9, etc.) is more than capable of running the agent workloads Champ targets.

**Architecture:**

```
┌─────────────────────────────────────────────────────┐
│  VS Code Extension (thin client)                     │
│  • Chat UI (webview)                                 │
│  • Model picker, diff overlay, team builder          │
│  • Connects to champd via localhost WebSocket        │
│  • Renders state pushed from daemon                  │
└──────────────────┬──────────────────────────────────┘
                   │ WebSocket (localhost:3147)
┌──────────────────▼──────────────────────────────────┐
│  champd — persistent background daemon               │
│  • Agent execution engine (all TeamRunner logic)     │
│  • LLM provider connections (kept warm)              │
│  • MCP server connections (kept alive)               │
│  • Session store (SQLite, not JSON files)            │
│  • Memory bank (user-level, not workspace-level)     │
│  • Background task queue (runs while VS Code closed) │
│  • REST API on localhost:3148 for CI/CD integration  │
│  • Multiple VS Code windows connect to same daemon   │
└─────────────────────────────────────────────────────┘
```

**What this unlocks:**
- Agents continue running when VS Code is closed or crashes
- Multiple VS Code windows share the same daemon — no duplicate MCP connections, no duplicate indexes
- Memory bank becomes machine-level (not workspace-level)
- The daemon exposes a REST API — GitHub Actions can POST a task and get a webhook when the agent completes
- VS Code extension startup is instant — it just connects to an already-running daemon
- Worker threads inside the daemon provide true parallelism (not extension host single-thread)

**What it costs:**
- Users must install `champd` as a separate process (launchd/systemd/Windows service)
- Local network socket introduces a new attack surface (must be auth'd with a token)
- Extension becomes stateless — all state is in daemon; more complex for testing
- Daemon versioning must be managed independently of the extension

**Migration path from current code:**
- Phase A: Move `TeamRunner`, `MCPClientManager`, `IndexingService` to daemon
- Phase B: Move `MemoryBank`, `SessionStore`, `AgentController` to daemon
- Phase C: VS Code extension keeps only UI — all messages proxied through daemon

**Effort estimate:** 8–10 weeks for full migration. Phase 3 (Worker thread execution) is the stepping stone — it proves the execution isolation pattern before the daemon split.

---

### Option B: Cloud Execution Layer *(Long-Term — Maximum Capability)*

**Core idea:** Agent execution moves to cloud infrastructure. VS Code extension is a pure thin client. Users log in with an account.

**Architecture:**

```
┌──────────────────────────────────────────────────────┐
│  VS Code Extension (thin client)                      │
│  • Chat UI only — renders state from cloud            │
│  • No LLM calls, no agent logic, no file execution   │
│  • Streams diffs from cloud to local file system     │
└──────────────────┬───────────────────────────────────┘
                   │ HTTPS + WebSocket
┌──────────────────▼───────────────────────────────────┐
│  Champ Cloud Platform                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Agent Runner │  │  MCP Gateway │  │  LLM Router │ │
│  │  (k8s pods) │  │  (managed)   │  │  (caching)  │ │
│  └─────────────┘  └──────────────┘  └─────────────┘ │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Memory DB  │  │  Audit Log   │  │  Team Mgmt  │ │
│  │ (Postgres)  │  │  (append-only│  │  (RBAC)     │ │
│  └─────────────┘  └──────────────┘  └─────────────┘ │
└──────────────────────────────────────────────────────┘
```

**What this unlocks:**
- Agents run for hours or days independently
- True horizontal scale — 100 agents in parallel
- Cross-machine persistent memory, conversations, team definitions
- Team collaboration — multiple developers share agents, rules, memory
- MCP Gateway becomes a real managed service with ACL, rate limiting, caching
- Enterprise controls: SSO, RBAC, audit log, data residency
- CI/CD integration is trivial — just an HTTP API

**What it costs:**
- Requires cloud infrastructure (significant ops investment)
- User data leaves the machine (privacy-sensitive environments cannot use it)
- Requires identity, billing, multi-tenancy — all non-trivial
- Local LLM support (Ollama/llama.cpp) is incompatible with cloud execution — this is a strategic fork: local-first vs. cloud-first
- 12–18 months of engineering before the product is production-ready

**This option requires a strategic decision:** abandon local-first or run two separate products (local extension + cloud platform). The leading cloud tool made this choice years ago and has moved entirely to cloud execution. Their local model support is minimal.

---

### Option C: VS Code Fork *(Competitive Parity — Highest Effort)*

**Core idea:** Fork VS Code (MIT licensed), distribute as a separate application ("Champ IDE"), own the editor stack. This is how the most dominant competitor achieved their current position.

**Architecture:**
- Fork `microsoft/vscode` at a stable tag
- Maintain a patch set on top of upstream
- Distribute as a signed application (not a marketplace extension)
- Integrate Champ directly into the editor renderer — not via extension APIs
- Run agents in the app's main/worker processes — not extension host
- Deep diff viewer, inline suggestion rendering, terminal integration at process level

**What this unlocks:**
- Pixel-perfect diff rendering (not gutter decorations)
- Inline suggestion streaming that looks native to the editor
- Terminal output available directly (no extension host proxy)
- Background agent execution in the app's worker pool
- Full control over the extension host — can give Champ agents more resources

**What it costs:**
- Maintaining a VS Code fork is significant ongoing work (upstream merges, security patches)
- Users must install a separate application — friction vs. a marketplace extension
- All existing VS Code extensions must be tested for compatibility
- The leading competitor is 4+ years ahead on this path with a large team
- Effectively competing in the IDE market, not the extension market — different competitive surface

**This option is only recommended** if the strategic goal is to be a full IDE replacement. If the goal is to be the best AI assistant for VS Code users, Option A achieves that without the maintenance burden of an editor fork.

---

## Summary: Recommended Path

| Decision | Recommendation | Why |
|---|---|---|
| Phases 1–5 | Implement in sequence per this plan | Each phase is independently valuable; review gates catch issues early |
| Phase 6 architecture | **Option A: Local daemon** | Unlocks the most important gaps (background execution, multi-window, CI/CD) with the least strategic risk. Does not require cloud infrastructure or abandoning local-first design. Preserves Ollama/llama.cpp support. |
| Long-term | Re-evaluate Option B after Option A ships | Cloud execution becomes compelling once there is an established user base and the privacy/local-model tradeoffs are understood from real usage |
| VS Code fork | Do not pursue | Cost/benefit is unfavorable given current team size and the lead time already established by the dominant fork-based competitor |

**The single most important feature to build first:** Worker thread execution (Phase 3, first task). It is the stepping stone to the daemon architecture. It proves the message protocol, it isolates the agent loop today, and it becomes the daemon's core when Option A is implemented.
