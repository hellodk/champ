# Champ — AI Coding Agent for VS Code

Open-source VS Code extension that puts an autonomous coding agent in your editor with **full local-LLM support**, multi-agent orchestration, a fresh RAG codebase index, and defense-in-depth safety. Built in TypeScript, TDD-first (1,900+ tests).

```
User ─▶ Sidebar Chat ─▶ AgentController ─┬─▶ LLM Provider (7 backends)
      (@Files @Codebase @Git …)          ├─▶ ToolRegistry (19 tools, approval-gated)
                                         ├─▶ RAG Index (watcher-fresh, persisted)
                                         └─▶ Multi-Agent Teams / Workflows / MCP
```

---

## Features

### Providers & models
- **7 providers behind one interface** — Claude, OpenAI, Gemini, Ollama, llama.cpp, vLLM and any OpenAI-compatible endpoint (vLLM, LM Studio, omlx, …)
- **Local-first** — run entirely offline; discovery scans every configured server and lists all models in the picker
- **Native tool-calling opt-in** for OpenAI-spec servers via `supportsTools: true` in YAML
- **Smart Router** — auto-picks the right model per task type (coding / chat / completion), with user-defined routing rules, circuit breakers and fallback chains

### Agentic core
- **Agent loop** with iteration cap, abort-safety, staged atomic edits, and per-tool approval previews
- **Hallucination guard** — detects narrated-but-never-executed tool calls and forces real `<tool_call>` emission
- **Tool-call hardening** — arguments schema-validated before execution with corrective feedback to the model
- **Resilience** — per-request HTTP timeouts, bounded exponential backoff honoring `Retry-After`, workflow-wide retry budgets that terminate runaway retry loops
- **Context management** — token-budgeted compaction with LLM summaries, repo-map grounding, terminal output buffer for `@Terminal`

### Multi-agent & automation
- **Pipeline runner** (`planner → context → code → reviewer → validator`) and DAG orchestrator with conditional branching and dynamic routing
- **Agent Teams** — YAML-defined teams running in topological parallel groups with shared memory, token budgets, pause/resume, checkpoints, and dynamic agent spawning (`SPAWN:` protocol)
- **Auto-fix loop** — LSP-diagnostics-driven fix iterations after edits
- **Test-driven fix loop** — runs your test suite and iterates until green

### RAG codebase index
- Language-aware AST chunking (TS/JS) + sliding windows elsewhere
- HNSW vector search (brute-force below 10k chunks), model-scoped embedding cache on disk
- **Persisted index reused across sessions** and kept fresh by a file watcher — create/change/delete reindex within ~500 ms
- Query via `@Codebase` or the `codebase_search` tool (ripgrep fallback when the index is cold)

### Editor integrations
- **Sidebar chat** — Agent / Ask / Manual / Plan / Composer modes, rAF-batched streaming (smooth even on long answers), lazy-loaded syntax highlighting
- **Inline ghost-text autocomplete** from a small fast model with stale-request cancellation
- **Hunk-level diff overlay** — accept/reject individual changes via CodeLens + gutter markers
- **@-context symbols** — `@Files`, `@Folders`, `@Code`, `@Codebase`, `@Web`, `@Git`, `@Docs`, `@Symbols`, `@Terminal`, `@GitBlame`, `@TestFor`, `@PR(123)`, `@Issue(456)`, `@MCP(server:uri)`
- **Skills** — `/explain`, `/test`, `/refactor`, `/review`, `/commit`, `/doc`, `/fix`, `/optimize` plus workspace/user skills with frontmatter

### Safety
- Command denylist sandbox (`rm -rf /`, `curl | bash`, sudo…), allowlist mode
- Secret scanner redacts keys/credentials in tool output before they reach the LLM; PII scanner on input
- PromptGuard screens user input *and* tool outputs for injection patterns
- Path-traversal guards on every file tool (symlink-aware)
- Hash-chained audit log with tamper verification
- Approval flow: per-action prompts by default, `champ.yoloMode` kill-switch, team modes (safe/supervised/auto)

### Configuration — one source of truth
```yaml
# .champ/config.yaml  (workspace)   or   ~/.champ/config.yaml  (user)
provider: openai-compatible            # active provider
providers:
  openai-compatible:                   # any OpenAI-spec server
    baseUrl: http://192.168.1.5:8000/v1   # note the /v1 suffix
    model: mlx-community--Qwen3.5-4B-MLX-4bit
    apiKey: dummy                      # self-hosted keys allowed here
    supportsTools: true                # native OpenAI tool calling
  ollama:
    baseUrl: http://127.0.0.1:11434
    model: qwen2.5-coder:1.5b
agent:
  yoloMode: false                      # true = skip approval prompts
indexing:
  enabled: true                        # RAG index
```
- Precedence: workspace YAML > user YAML > VS Code settings > defaults
- **`champ.configSource`** setting pins ONE source explicitly (`workspace-yaml` | `user-yaml` | `settings`) — ignored layers are logged
- **`Champ: Show Effective Config`** prints the merged result annotated with which layer supplied every key
- Cloud API keys always go to SecretStorage (`Champ: Set API Key`) — never YAML

### Observability
- Bounded metrics buffers (requests, steps, tool calls, failures) + authenticated Prometheus `/metrics` on the local API server
- Optional OTLP export of agent-run analytics
- Hash-chained audit log (`Champ: Verify Audit Log`)
- Local API server (`Champ: Show API Server Info`) with timing-safe bearer auth

---

## Install

```bash
code --install-extension champ-1.7.0.vsix
```

Or build from source:

```bash
pnpm install
pnpm run compile
npx @vscode/vsce package --no-dependencies
code --install-extension champ-<version>.vsix
```

## Quick start

1. Reload VS Code → open the **Champ** sidebar.
2. Pick a provider: either use settings, or drop a `.champ/config.yaml` like the one above into your project.
3. Run **Champ: Show Effective Config** to confirm what's live.
4. Chat. In *agent* mode Champ reads files, edits, and runs commands — each destructive action asks first unless yoloMode is on.

### Using agentic tasks against a local OpenAI-compatible server

```yaml
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: http://your-server:8000/v1
    model: <model-id-from-/v1/models>
    apiKey: <token-if-required>
    supportsTools: true     # enables native function calling
```

Then ask things like *"find all TODOs under src/ and summarize"* — Champ streams the plan, calls tools (you see each call as a card), executes them sandboxed/approved, and iterates until done.

## Useful commands

| Command | Purpose |
|---|---|
| `Champ: Show Effective Config` | merged config + per-key origin layer |
| `Champ: Index Workspace` / auto | rebuild / incrementally refresh RAG index |
| `Champ: Rescan Models` | re-discover models on all servers |
| `Champ: Set API Key` | store cloud provider key in SecretStorage |
| `Champ: Save/Restore Checkpoint` | snapshot & roll back workspace state |
| `Champ: Run Multi-Agent Workflow` / `Run Agent Team` | orchestration entry points |
| `Champ: Verify Audit Log` | validate hash chain |

## Configuration sources

| Source | File / place |
|---|---|
| Workspace YAML | `<repo>/.champ/config.yaml` |
| User YAML | `~/.champ/config.yaml` |
| VS Code settings | `champ.*` in Settings UI |
| Defaults | built-in |

Pin one with `champ.configSource`; inspect the winner any time via **Show Effective Config**.

## Development

```bash
pnpm install          # pnpm is the only package manager
pnpm run watch        # esbuild watch (ext + webview)
pnpm run test:unit    # 190+ files, 1,600+ tests
pnpm run check-types && pnpm run lint
pnpm run compile      # production bundle
npx @vscode/vsce package --no-dependencies
```

Architecture notes, plans and reviews live in [`docs/`](docs/) (`ARCHITECTURE.md`, `CONFIG.md`, `TEAMS.md`, review documents).

## License

MIT — see [LICENSE](LICENSE).
