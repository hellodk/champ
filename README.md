# Champ — AI Coding Agent for VS Code & Terminal

Open-source coding agent for **VS Code** and the **terminal (`champ` CLI)** with local-first LLM support, multi-agent orchestration, a watcher-fresh RAG codebase index, skills, project rules, and defense-in-depth safety. Built in TypeScript with TDD (220+ test files, 2,000+ unit tests).

```
User ─▶ VS Code / CLI ─▶ AgentController ─┬─▶ EndpointRegistry (7 providers)
      (@Files @Codebase @Git / Skills)    ├─▶ ToolRegistry (approval-gated)
                                          ├─▶ RAG Index (watcher-fresh, persisted)
                                          └─▶ Multi-Agent Teams / Workflows / MCP
```

---

## Index

- [Install](#install)
  - [Headless CLI (Linux / macOS one-liner)](#headless-cli-no-vs-code)
  - [VS Code Extension](#vs-code-extension)
- [Quick Start](#quick-start)
- [Features](#features)
  - [Providers & models](#providers--models)
  - [Agentic core](#agentic-core)
  - [Multi-agent & automation](#multi-agent--automation)
  - [RAG codebase index](#rag-codebase-index)
  - [Editor integrations](#editor-integrations)
  - [Safety](#safety)
  - [Observability](#observability)
- [Configuration](#configuration)
- [Useful Commands](#useful-commands)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

---

## Install

### Headless CLI (no VS Code)

Champ ships as a standalone CLI (`champ`) for terminals, CI, and remote machines without VS Code. The bundle inlines its runtime dependencies and only requires **Node.js 20+** (no root access needed).

**One-liner (Linux / macOS — rootless install into `~/.local`, requires `node >= 20`, `npm`, and `git`; safe to re-run to upgrade):**

```bash
tmp=$(mktemp -d) && git clone --depth 1 https://github.com/hellodk/champ.git "$tmp/champ" && (cd "$tmp/champ" && npm install --ignore-scripts --no-audit --no-fund --no-package-lock && node esbuild.mjs --production && npm pack --ignore-scripts && npm install -g --prefix "${CHAMP_PREFIX:-$HOME/.local}" --force --ignore-scripts --no-audit --no-fund ./champ-*.tgz) && rm -rf "$tmp" && export PATH="${CHAMP_PREFIX:-$HOME/.local}/bin:$PATH" && hash -r && champ --version
```

Once installed, you can also update anytime with `champ update`. Add `~/.local/bin` to `~/.bashrc` or `~/.zshrc` if not already on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**From an existing local checkout:**

```bash
node esbuild.mjs --production          # builds dist/cli.js (standalone, vscode-free)
npm pack --ignore-scripts              # creates champ-<version>.tgz (CLI payload only)
npm install -g --force ./champ-*.tgz   # or: npm link
champ --version
```

### VS Code Extension

Install from a `.vsix` file or via the repo script:

```bash
code --install-extension champ-<version>.vsix
# or from a checkout:
scripts/champ install
```

Or build from source:

```bash
pnpm install
pnpm run compile
npx @vscode/vsce package --no-dependencies
code --install-extension champ-<version>.vsix
```

---

## Quick Start

### Terminal CLI

1. Run the interactive provider wizard (no YAML hand-editing required):
   ```bash
   champ setup
   ```
2. Run a one-shot task, pipe stdin, or start the full-screen TUI:
   ```bash
   champ "find all TODOs under src/ and summarize"
   echo "explain src/cli.ts" | champ
   champ                      # full-screen TUI (when stdin is a terminal)
   champ --repl               # line REPL instead of the TUI
   champ --sessions           # list stored workspace sessions
   champ --list-skills        # list built-in, user, and workspace skills
   ```

Approvals prompt when a human is attached to the terminal. Non-interactive runs without `--yes` deny approval-requiring actions; `-y` opts in to auto-approval. Model replies go to `stdout` and diagnostics go to `stderr`, so `champ "..." > plan.md` captures only the answer.

The CLI exposes the same 17 non-SSH built-in tools as the extension (terminal, git, web search, URL fetch, browser, codebase search, docs, delegation and more) plus MCP tools from `mcp.servers`. `web_search` reads its Brave key from `BRAVE_API_KEY` or the OS keyring entry `brave-search-api-key`.

### VS Code Extension

1. Open the **Champ** sidebar in VS Code.
2. Run **`Champ: Configure Provider`** (`Ctrl+Shift+P` / `Cmd+Shift+P`) or reuse endpoints already saved by `champ setup`.
3. Chat in **Agent**, **Ask**, **Manual**, **Plan**, or **Composer** mode. Destructive actions prompt before running unless `yoloMode` is enabled.

---

## Features

### Providers & models

- **7 provider kinds behind one interface** — Anthropic Claude, OpenAI, Google Gemini, Ollama, llama.cpp, vLLM, and any OpenAI-compatible server (MLX, LM Studio, etc.)
- **Shared local-first registry** — `champ setup` and VS Code share `~/.champ/providers.json` while keeping credentials in OS keyring / env vars (CLI) or VS Code `SecretStorage` (extension)
- **Live model discovery & health checks** — probes `/v1/models` or `/api/tags` (with Bearer auth when configured) and records latency via `champ provider test`
- **Smart Router & fallback chains** — task-based routing (coding / chat / completion / embedding), circuit breakers, and fallback chains

### Agentic core

- **Agent loop** with iteration caps, abort safety, staged atomic edits, and per-tool approval previews
- **Hallucination guard** — detects narrated-but-never-executed tool calls and enforces real tool invocation
- **Tool-call hardening** — arguments schema-validated before execution with corrective feedback
- **Resilience** — per-request HTTP timeouts, bounded exponential backoff honoring `Retry-After`, and workflow-wide retry budgets
- **Context management** — token-budgeted compaction with LLM summaries, repo-map grounding, and `@Terminal` output buffering

### Multi-agent & automation

- **Pipeline runner** (`planner → context → code → reviewer → validator`) and DAG orchestrator with conditional branching and dynamic routing
- **Agent Teams** — YAML-defined teams running in parallel dependency groups with shared memory, token budgets, pause/resume, checkpoints, and dynamic `SPAWN:` agents
- **Auto-fix loop** — LSP-diagnostics-driven fix iterations after edits
- **Test-driven fix loop** — runs your test suite and iterates until green

### RAG codebase index

- Language-aware AST chunking (TS/JS) plus sliding windows elsewhere
- HNSW vector search with a persisted, model-scoped embedding cache on disk
- File-watcher incremental reindexing and `codebase_search` / `@Codebase`

### Editor integrations

- **Sidebar chat** — rAF-batched streaming and lazy-loaded syntax highlighting
- **Inline ghost-text autocomplete** with stale-request cancellation
- **Hunk-level diff overlay** — accept/reject individual changes via CodeLens and gutter markers
- **@-context symbols** — `@Files`, `@Folders`, `@Code`, `@Codebase`, `@Web`, `@Git`, `@Docs`, `@Symbols`, `@Terminal`, `@GitBlame`, `@TestFor`, `@PR(123)`, `@Issue(456)`, `@MCP(server:uri)`
- **Skills & rules** — built-in skills (`/explain`, `/test`, `/refactor`, `/review`, `/commit`, `/doc`, `/fix`, `/optimize`) plus workspace/user skills (`.champ/skills/*.md`) and rules (`.champ/rules/*.md`) in both VS Code and the CLI

### Safety

- Command denylist sandbox (`rm -rf /`, `curl | bash`, `sudo`, …) and allowlist mode
- Secret scanner redacts credentials before they reach tool output; PII scanner on input
- PromptGuard screens user input and tool outputs for injection patterns
- Symlink-aware path-traversal guards on every file tool
- Hash-chained audit log with tamper verification
- Per-action approval prompts by default, optional `yoloMode`, and team safety modes (`safe`/`supervised`/`auto`)

### Observability

- Bounded metrics buffers and authenticated Prometheus `/metrics` on the local API server
- Optional OTLP analytics export
- Hash-chained audit log (`Champ: Verify Audit Log`) and timing-safe local API server (`Champ: Show API Server Info`)

---

## Configuration

Provider endpoints are managed automatically via `champ setup` / `Champ: Configure Provider`; non-provider settings (`userRules`, `agent`, `indexing`, `mcp`, `routing`, `telemetry`) live in `~/.champ/config.yaml`.

| Layer             | Purpose                                                                                   | Location                                               |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| CLI flags         | Explicit per-run overrides (`--provider`, `--base-url`, `--model`, `--api-key`)           | Command line                                           |
| Workspace ref     | Optional non-secret endpoint/model pointer (`champ model use <id>/<model> --workspace`)   | `<repo>/.champ/provider.json`                          |
| Endpoint registry | Named endpoints, discovered models, task assignments (no secrets)                         | `~/.champ/providers.json`                              |
| User YAML         | Non-provider settings (`userRules`, `agent`, `mcp`, `indexing`) + legacy migration source | `~/.champ/config.yaml` (or `CHAMP_CONFIG`)             |
| Credentials       | Secrets kept out of JSON/YAML                                                             | OS keyring / env vars (CLI), `SecretStorage` (VS Code) |

Migrate an existing `~/.champ/config.yaml` provider block into the registry at any time:

```bash
champ config migrate --dry-run
champ config migrate
```

---

## Useful Commands

### CLI commands

| Command                                                  | Purpose                                               |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `champ setup`                                            | Interactive endpoint setup + model discovery          |
| `champ provider list \| add \| edit <id> \| remove <id>` | Manage saved endpoints                                |
| `champ provider test <id> \| discover <id>`              | Test connectivity/latency or refresh models           |
| `champ models [refresh]`                                 | List or refresh discovered models                     |
| `champ model use <id>/<model> [--workspace]`             | Set default model globally or for a repo              |
| `champ config show \| migrate [--dry-run]`               | Inspect redacted config or import legacy YAML         |
| `champ update [--check \| --force \| --ref <ref>]`       | Update the `champ` CLI installation from upstream git |

### VS Code commands

| Command                                                | Purpose                                    |
| ------------------------------------------------------ | ------------------------------------------ |
| `Champ: Configure Provider`                            | Guided provider setup wizard               |
| `Champ: Show Effective Config`                         | Active config and origin diagnostics       |
| `Champ: Index Workspace`                               | Rebuild / refresh RAG index                |
| `Champ: Rescan Models`                                 | Re-discover models on configured endpoints |
| `Champ: Set API Key`                                   | Store cloud keys in `SecretStorage`        |
| `Champ: Save Checkpoint` / `Champ: Restore Checkpoint` | Snapshot & restore workspace state         |
| `Champ: Run Multi-Agent Workflow`                      | Multi-agent orchestration entry point      |
| `Champ: Verify Audit Log`                              | Validate audit hash chain                  |

---

## Development

```bash
pnpm install
pnpm run watch
pnpm run test:unit
pnpm run check-types && pnpm run lint
pnpm run compile
npx @vscode/vsce package --no-dependencies
```

---

## Documentation

- [Documentation Index](docs/README.md)
- [User Guide (Install, CLI, Extension, Skills, Teams)](docs/USER_GUIDE.md)
- [Configuration & Model Guide](docs/CONFIG.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [Interfaces & System Prompts Reference](docs/REFERENCE.md)
- [Operations, Security & Publishing](docs/OPERATIONS.md)

---

## License

MIT — see [LICENSE](LICENSE).
