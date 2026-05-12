# Champ Extension — Audit & Feature Roadmap
> Audit date: 2026-05-12 · Version audited: 1.6.6

---

## Executive Summary

Champ has a genuinely strong foundation: 7 LLM providers, 11 tools, 5 agent modes, 6 multi-agent sub-agents, MCP integration, semantic indexing, session persistence, and a full safety stack. The danger is that several half-built features (web search, @Codebase, token accounting, rules loading) reduce user trust without adding capability. The priority is to wire existing components before building new ones.

---

## 1. Current Implementation Status

### ✅ Fully Implemented

| Component | Location | Notes |
|-----------|----------|-------|
| Agent system (5 modes) | `src/agent/agent-controller.ts` | agent/ask/manual/plan/composer; 25-iteration limit; native + prompt-based tool calling |
| LLM Providers (7) | `src/providers/` | Claude, OpenAI, Gemini, Ollama, llama.cpp, vLLM, OpenAI-compatible |
| Tool suite (11 tools) | `src/tools/` | read, edit, create, delete, list, terminal, grep, file search, semantic search, diagrams, docs |
| Multi-agent pipeline | `src/agent/agents/`, `src/agent/orchestrator.ts` | 6 sub-agents, retry branching, shared memory |
| Session management | `src/agent-manager/` | Disk persistence, pruning, lifecycle |
| Safety stack | `src/safety/` | PromptGuard, PiiScanner, SecretScanner, CommandSandbox |
| Skills / slash commands | `src/skills/` | 8 built-in, template system, workspace/user/built-in precedence |
| Smart Router | `src/providers/smart-router.ts` | Discovery, scoring, task routing, manual override |
| Config system | `src/config/config-loader.ts` | YAML schema, validation, SecretStorage integration |
| Context Window Manager | `src/providers/context-manager.ts` | Dynamic detection, message fitting, output reservation |
| Semantic index | `src/indexing/` | Embedding service, chunking, in-memory vector store |

### ⚠️ Partially Implemented (Wired but Incomplete)

| Component | Location | Gap |
|-----------|----------|-----|
| MCP integration | `src/mcp/` | Tools work; resources/sampling/prompts not implemented; no management UI |
| Multi-agent ContextAgent | `src/agent/agents/context-agent.ts` | Reads plan-named files naively; doesn't call embedding search |
| Observability / token accounting | `src/observability/` | Analytics structure ready; stream deltas never carry token counts |
| Checkpoints | `src/checkpoints/checkpoint-manager.ts` | Manager built; no UI command to trigger save/restore |
| Rules engine | `src/rules/rules-engine.ts` | `loadRules()` is a stub; `.champ/rules/` files not loaded |
| @Codebase context reference | `src/agent/context-resolver.ts:652` | Parser recognises `@Codebase`; returns empty — IndexingService not called |
| Image upload | `src/ui/chat-view-provider.ts` | ContentBlock[] backend ready; no webview drag-drop UI |
| Auto-fix loop | `src/auto-fix.ts` | Built; not integrated into multi-agent workflow |

### ❌ Stubbed / Missing

| Component | Location | Notes |
|-----------|----------|-------|
| Web search | `src/extension.ts:1268` | Tool registered; always returns "not yet wired" |
| Parallel tool execution | — | Agent loop is serial; no parallel independent tool calls |
| Cost tracking | — | Metrics framework present; no per-call cost estimation |
| Rate-limit backoff | — | Provider errors surface directly; no retry/backoff |
| Context summarisation | — | Old messages dropped (not summarised); context loss on long sessions |

---

## 2. Current Gap Fixes (Phase 1)

> These are all "wiring" tasks — the infrastructure exists, components just aren't connected.

### P1-1: Wire @Codebase to embedding search
**File:** `src/agent/context-resolver.ts` line 652  
**Fix:** When `@Codebase` is parsed, call `IndexingService.search(query)` and return top-K chunks instead of returning empty.  
**Impact:** Users can reference their entire codebase semantically in chat.

### P1-2: Fix web_search tool
**File:** `src/extension.ts:1268`, `src/tools/`  
**Fix:** Implement real web search via Brave Search API (configurable key in YAML) or fallback to a local scraper. Support result ranking and snippet extraction.  
**Impact:** Agents can fetch current docs, check package versions, search for error solutions.

### P1-3: Checkpoint UI
**File:** `src/checkpoints/checkpoint-manager.ts`, `src/extension.ts:1272`  
**Fix:** Register `champ.saveCheckpoint` and `champ.restoreCheckpoint` commands. Add keyboard shortcut and status bar button. Wire to existing CheckpointManager.  
**Impact:** Users can save/restore agent state mid-task.

### P1-4: Token accounting
**File:** `src/agent/agent-controller.ts`, stream delta handling  
**Fix:** Claude SDK already returns token counts in the `done` delta. Parse and forward them to AgentAnalytics. Display in metrics panel.  
**Impact:** Users see real token/cost usage per task.

### P1-5: Rules loading
**File:** `src/rules/rules-engine.ts` — `loadRules()` stub  
**Fix:** Implement loading from `.champ/rules/*.md` (workspace) and `~/.champ/rules/*.md` (user). Support `always`, `auto-attached` (glob match), and `agent-requested` types.  
**Impact:** Project-level coding rules always injected into agent context.

### P1-6: ContextAgent embedding search
**File:** `src/agent/agents/context-agent.ts`  
**Fix:** Replace naive "read all plan-mentioned files" with embedding search over IndexingService for semantic retrieval.  
**Impact:** Multi-agent workflows get better context; fewer hallucinated file reads.

---

## 3. Feature Gap Analysis

### 3.1 Agent Manager
**Current state:** `AgentManager` in `src/agent-manager/` is fully implemented but only exposed as session tabs.  
**Gap:** No visual dashboard for running agents; no pause/resume/kill-by-id; no queue visibility.  
**Benefit:** Users can manage long-running tasks, inspect state, kill stuck agents.  
**Effort:** Low — wire existing API to a panel UI.

---

### 3.2 Agent Gateway
**Current state:** `ChatViewProvider` routes messages internally.  
**Gap:** No external API (REST/WebSocket) for calling Champ from CI pipelines, scripts, or other tools.  
**Benefit:** Champ becomes usable headlessly from terminal, GitHub Actions, other IDEs.  
**Effort:** Medium — add HTTP server with auth token; expose `processMessage` endpoint.  
**Verdict:** High value if users want automation pipelines. Not urgent for a UI-first tool.

---

### 3.3 Agent Builder
**Current state:** Skills YAML provides basic customisation. No full agent composition UI.  
**Gap:** No way to define custom agents with system prompts, tool access, model, and output schemas without code.  
**Benefit:** Power users build domain-specific agents (docs writer, migration assistant, security auditor).  
**Effort:** Medium — extend skill YAML schema to include `agent:` definitions; add validation.  
**Verdict:** High value. Don't build a drag-and-drop GUI — well-structured YAML + schema validation is enough.

---

### 3.4 Sub-Agents
**Current state:** 6 sub-agents exist (`planner`, `context`, `code`, `reviewer`, `validator`, `file`). Pipeline is linear with retry branching.  
**Gap:** Pipeline is hardcoded — no dynamic DAG composition; no conditional branching based on agent output; no parallelism.  
**Benefit:** Reviewer can conditionally spawn a debugging agent; planner can spawn parallel research agents; massive capability increase.  
**Effort:** Medium — replace linear pipeline in `orchestrator.ts` with a DAG executor.  
**Verdict:** The most impactful architectural improvement available. Build this in Phase 3.

---

### 3.5 Agent SDK
**Current state:** All agent code is internal. No published interface.  
**Gap:** No npm package exposing `AgentController`, `ToolRegistry`, `LLMProvider` interfaces for external use.  
**Benefit:** Community can build Champ-compatible domain-specific agents and publish them.  
**Effort:** High — requires stable public API contract and maintenance commitment.  
**Verdict:** High strategic value for an ecosystem. Stabilise internals first (Phases 1–2). Publish SDK in Phase 4.

---

### 3.6 MCP Manager
**Current state:** `McpRegistry` + `MCPClientManager` handle server lifecycle. Tools are registered and callable.  
**Gap:** No UI to add/remove/test servers; MCP resources/sampling/prompt protocols not implemented; VS Code SecretStorage injection partially broken.  
**Benefit:** Full MCP compliance means every community MCP server (GitHub, Slack, Playwright, databases) works out of the box. Champ becomes a first-class MCP host.  
**Effort:** Medium — protocol gaps are well-defined; UI is straightforward.  
**Verdict:** High priority. MCP is the interoperability layer for the AI agent ecosystem.

---

### 3.7 Optimiser
**Most impactful interpretation:** Context window optimiser — summarise old turns with an LLM instead of dropping them.  
**Current state:** Old messages are dropped (oldest-first) when context fills. Context is lost permanently.  
**Gap:** No LLM-based compaction; no quality scoring to prefer better responses; SmartRouter already handles model routing.  
**Benefit:** Agents remember earlier parts of long sessions. Code reviews and refactors don't lose early decisions.  
**Effort:** Medium — add a summarisation pass before message drop in `ContextWindowManager`.  
**Verdict:** Build the context summariser in Phase 2. Other optimiser interpretations (cost, quality scoring) are lower priority.

---

### 3.8 Agent Identity
**Current state:** Agents have names in analytics logs but no formal identity, no signing, no trust model.  
**Gap:** No stable agent ID, capability declaration, or trust chain.  
**Benefit:** Prevents rogue agent impersonation; enables audit trails; required for secure A2A communication.  
**Effort:** Low–medium once the model is defined.  
**Verdict:** Build this when building A2A protocol (Phase 5). Overkill for a single-user tool today.

---

### 3.9 Agent Development Kit (ADK)
**What it is:** Developer tooling — `champ init-agent` CLI, agent template library, local test runner, schema validator.  
**Current state:** Nothing exists.  
**Benefit:** Dramatically reduces friction for contributors and ecosystem builders.  
**Effort:** Medium — mostly scaffolding and documentation tooling.  
**Verdict:** Build after SDK is stable. ADK is the developer-experience layer on top of the SDK. Phase 4.

---

### 3.10 Agent-to-Agent Protocol (A2A)
**What it is:** Agents discover, call, and collaborate with remote agents across machines/orgs using a standardised message format, identity, and async request-response.  
**Current state:** Only `SharedMemory` for in-process communication.  
**Gap:** No discovery registry, no standardised message schema, no auth, no async broker.  
**Benefit:** Champ can orchestrate external specialist agents (CI test agent, docs agent, code review bot). Massive capability unlock.  
**Effort:** High. Requires Agent Identity, standardised schemas, auth layer, and potentially a message broker.  
**Verdict:** Very high long-term value. Build Agent Identity and sub-agent DAG first. A2A without identity is insecure. Phase 5.

---

### 3.11 App Builder / Agent Studio
**What it is:** Visual drag-and-drop or low-code environment to compose agent workflows, connect agents, define triggers, build autonomous pipelines.  
**Current state:** No foundation for this yet.  
**Benefit:** Non-developers build complex multi-step pipelines. "On git push → run code agent → review agent → create PR."  
**Effort:** Very high. Requires every layer below it: Agent Builder, Sub-agent DAG, A2A, SDK, Gateway.  
**Verdict:** Phase 5–6. Building this before the foundation is solid would produce a facade with no substance. 18–24 months out.

---

### 3.12 Agent Engine
**Current state:** `AgentController` + `MultiAgentRunner` + `AgentOrchestrator` together ARE an agent engine, informally.  
**Gap:** No hot-reload; no event-driven triggers (file watch → agent run); no scheduling; no persistent task queue.  
**Benefit:** Champ becomes proactive. "Watch this file; run the test coverage agent whenever it changes."  
**Effort:** Medium — VS Code's file system watcher APIs support triggers natively.  
**Verdict:** Event-driven triggers are high value and achievable within VS Code. Build in Phase 3.

---

### 3.13 Memory Bank
**Current state:** Session storage (conversation history). In-memory vector store (resets on restart). Ephemeral `SharedMemory` (per-workflow).  
**Gap:** No persistent long-term semantic memory. No learned preferences. No cross-session knowledge retention.  
**Benefit:** Agents remember your coding style, architectural decisions, off-limits modules, preferred libraries. Every session starts smarter.  
**What to build:**
- Persist vector store to SQLite + sqlite-vec (already referenced in `vector-store.ts` but using in-memory fallback)
- Memory manager that writes learned facts as embeddings
- System prompt injection of relevant memories at session start
- TTL / eviction policy

**Effort:** Medium — infrastructure partially exists.  
**Verdict:** **Single highest-value missing feature.** Transforms Champ from a chat tool into a true AI collaborator. Build in Phase 2.

---

## 4. Recommended Build Phases

```
Phase 1 — Fix what's broken (2–4 weeks)
  ├── P1-1: Wire @Codebase to IndexingService embedding search
  ├── P1-2: Implement web_search (Brave API or fallback scraper)
  ├── P1-3: Checkpoint save/restore UI commands
  ├── P1-4: Token accounting from stream deltas
  ├── P1-5: Rules loading from .champ/rules/*.md
  └── P1-6: ContextAgent — replace naive file reads with embedding search

Phase 2 — High-value gaps (1–2 months)
  ├── Memory Bank (persist vector store → SQLite; learned facts injection)
  ├── Context window summariser (LLM compaction replaces drop-oldest)
  ├── MCP Manager UI + complete resources/sampling protocol
  └── Agent Manager dashboard UI

Phase 3 — Ecosystem foundation (2–4 months)
  ├── Sub-agent DAG composer (replace linear hardcoded pipeline)
  ├── Agent Builder (YAML-defined custom agents with validation)
  ├── Event-driven triggers (Agent Engine)
  └── Agent Identity (stable IDs, capability declarations)

Phase 4 — Platform (4–8 months)
  ├── Agent SDK (npm package, public API contract)
  ├── Agent Development Kit (CLI scaffolding, test runner, templates)
  └── Agent Gateway (REST/WebSocket API, auth tokens)

Phase 5 — Advanced (8+ months)
  ├── Agent-to-Agent Protocol (discovery, async messaging, trust chains)
  ├── Optimiser (response quality scoring, cost enforcement)
  └── Agent Studio App Builder (visual workflow composer)
```

---

## 5. Priority Matrix

| Feature | User Value | Build Effort | Priority |
|---------|-----------|--------------|----------|
| @Codebase wiring | ⭐⭐⭐⭐⭐ | Low | P0 |
| Memory Bank | ⭐⭐⭐⭐⭐ | Medium | P0 |
| Web search | ⭐⭐⭐⭐ | Medium | P1 |
| Context summariser | ⭐⭐⭐⭐ | Medium | P1 |
| MCP Manager | ⭐⭐⭐⭐ | Medium | P1 |
| Rules loading | ⭐⭐⭐ | Low | P1 |
| Token accounting | ⭐⭐⭐ | Low | P1 |
| Checkpoint UI | ⭐⭐⭐ | Low | P1 |
| Sub-agent DAG | ⭐⭐⭐⭐ | Medium | P2 |
| Agent Builder | ⭐⭐⭐⭐ | Medium | P2 |
| Agent Engine (triggers) | ⭐⭐⭐⭐ | Medium | P2 |
| Agent Manager UI | ⭐⭐⭐ | Low | P2 |
| Agent SDK | ⭐⭐⭐⭐⭐ | High | P3 |
| Agent Gateway | ⭐⭐⭐ | Medium | P3 |
| ADK | ⭐⭐⭐ | Medium | P3 |
| Agent Identity | ⭐⭐ | Medium | P3 |
| A2A Protocol | ⭐⭐⭐⭐⭐ | Very High | P4 |
| Agent Studio | ⭐⭐⭐⭐⭐ | Very High | P5 |

---

*Document generated from systematic codebase audit — 2026-05-12*
