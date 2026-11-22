# Champ User Guide

Complete guide for the **Champ VS Code extension** and the **headless `champ` CLI**. Requires **Node.js 20+**; no root access is needed.

## Index

1. [Installation](#installation)
2. [Provider Setup](#provider-setup)
3. [VS Code Extension](#vs-code-extension)
4. [Headless CLI](#headless-cli)
5. [Skills & Project Rules](#skills--project-rules)
6. [Agent Teams & Custom Agents](#agent-teams--custom-agents)
7. [MCP Servers](#mcp-servers)
8. [Keyboard Shortcuts](#keyboard-shortcuts)
9. [Troubleshooting](#troubleshooting)

---

## Installation

### Champ CLI (Linux / macOS one-liner)

Requires `node >= 20`, `npm`, and `git`:

```bash
tmp=$(mktemp -d) && git clone --depth 1 https://github.com/hellodk/champ.git "$tmp/champ" && (cd "$tmp/champ" && npm install --ignore-scripts --no-audit --no-fund --no-package-lock && node esbuild.mjs --production && npm pack --ignore-scripts && npm install -g ./champ-*.tgz) && rm -rf "$tmp" && champ --version
```

If `champ` is not found after installing, add your user npm bin directory to `~/.bashrc` or `~/.zshrc`:

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

Updating an existing global install:

```bash
champ update                             # update global CLI installation from upstream git
champ update --check                     # check for a newer version/commit without installing
champ update --force --ref <branch/tag>  # force reinstall from a specific branch or tag
```

From an existing checkout:
- **`npm link`** (after `node esbuild.mjs`) for local development.
- **Tarball**: `node esbuild.mjs --production && npm pack && npm install -g ./champ-<version>.tgz`.
- **No install**: `node dist/cli.js --cwd /path/to/project -y "List the files"`.

### VS Code Extension

- From VSIX: `code --install-extension champ-<version>.vsix` (or `Extensions: Install from VSIX...`).
- From a local checkout: `scripts/champ install` (latest GitHub release) or `scripts/champ install build` (local build).
- From source: `pnpm install && pnpm run compile && npx @vscode/vsce package --no-dependencies`.

---

## Provider Setup

Run the interactive wizard — **no YAML hand-editing required**:

```bash
champ setup
```

In VS Code, run **`Champ: Configure Provider`** (`Ctrl+Shift+P` / `Cmd+Shift+P`).

Both store endpoints in `~/.champ/providers.json` (permissions `0600`) and keep secrets out of JSON:
- **CLI secrets**: stored in OS keyring (`security` on macOS, `secret-tool` on Linux with D-Bus) with environment variable fallback (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_API_KEY`, `LLAMACPP_API_KEY`, `VLLM_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`).
- **VS Code secrets**: stored in encrypted `SecretStorage` using matching logical IDs (`champ.<provider>.apiKey`).

### Managing endpoints & models

```bash
champ provider list                          # list endpoints (keys never printed)
champ provider add | edit <id> | remove <id>
champ provider test <id>                     # check connectivity & latency
champ provider discover <id>                 # refresh models from /v1/models or /api/tags
champ models [refresh] [--endpoint <id>]     # list or refresh models
champ model use <id>/<model> [--workspace]   # set default globally or in .champ/provider.json
champ config show                            # redacted config view
champ config migrate [--dry-run]             # import URLs/models from ~/.champ/config.yaml
```

### Local backend quick commands

- **Ollama**: `ollama serve`, then `ollama pull qwen3:8b` and `ollama pull qwen2.5-coder:1.5b` (autocomplete) / `nomic-embed-text` (embeddings). Default URL: `http://localhost:11434`.
- **llama.cpp**: `./llama-server -m <model>.gguf --port 8080 --ctx-size 16384`. Default URL: `http://localhost:8080/v1`.
- **vLLM / OpenAI-compatible (MLX, LM Studio)**: default ports `8000` / `8080` with `/v1`.

---

## VS Code Extension

Open the **Champ** Activity Bar sidebar (chat toolbar with mode selector & New Chat, message stream with inline tool cards, textarea with `Cmd/Ctrl + Enter` to send).

### Modes

Switch modes from the dropdown or `Cmd/Ctrl + Shift + M`:
- **Agent** *(default)*: autonomous multi-step tool loop with approval for writes/commands.
- **Ask**: read-only Q&A (`read_file`, `list_directory`, `grep_search`, `file_search`, `codebase_search`).
- **Manual**: prompts before every single action.
- **Plan**: read-only research that produces a structured step-by-step plan.
- **Composer**: multi-file Plan → Diff → Apply workflow with git integration.

### Tools & Safety

19 tools cover file I/O (`read_file`, `edit_file`, `create_file`, `delete_file`, `list_directory`), search (`grep_search`, `file_search`, `codebase_search`, `web_search`), shell/git/browser (`run_terminal_cmd`, `run_tests`, `git_tool`, `browser`), SSH (`remote_run_terminal`, `remote_edit_file`), diagrams/docs (`generate_diagram`, `generate_doc`), delegation (`delegate_task`), and MCP (`mcp_<server>_<tool>`).

All writes and shell calls prompt unless `agent.yoloMode: true`. Terminal execution passes through `CommandSandbox`, outbound tool results pass through `SecretScanner` + `PromptGuard`, and file paths are symlink-guarded.

### @-Context Symbols, Autocomplete, Diffs & Checkpoints

- **@-mentions**: `@Files(path)`, `@Folders(path)`, `@Code` (selection), `@Symbols(name)`, `@Codebase` (RAG vector search), `@Web` (Brave Search via `Champ: Set Brave API Key`), `@Git` (`diff`/`log`), `@Terminal`, `@GitBlame`, `@TestFor`, `@PR(123)`, `@Issue(456)`, `@Docs`, `@MCP(server:uri)`.
- **Inline autocomplete**: ghost text after typing pauses (`autocomplete.debounceMs`); `Tab` accepts, `Esc` rejects.
- **Hunk diff overlay**: CodeLens + gutter markers to accept/reject individual edits.
- **Checkpoints & Sessions**: `Champ: Save Checkpoint` / `Champ: Restore Checkpoint` snapshot files independently of git; `MemoryBank` (`.champ/memory.json`) tracks pinned and recent session facts; `AgentManager` provides tabbed parallel sessions with status indicators.

---

## Headless CLI

```bash
champ "<task>"                             # one-shot run
champ -y "Fix the tests"                   # auto-approve writes
champ                                      # interactive REPL
champ --repl                               # force REPL (even with piped input)
echo "Explain src/cli.ts" | champ          # read prompt from stdin (same as `champ -`)
champ --session <id> "Continue task"       # create/resume append-only JSONL session
champ --sessions                           # list workspace sessions
```

Key flags: `--cwd <dir>`, `--provider <name>`, `--base-url <url>`, `--model <id>`, `--api-key <key>`, `--max-iter <n>`, `--skill <name>`, `--file <path>`, `--list-skills`, `--no-skills`, `-h`/`--help`, `-v`/`--version`.

REPL commands: `/skills`, `/<skill> [args]`, `/session`, `/sessions`, `/checkpoint [label]`, `/compact`, `/help`, `/exit`.

Contracts: replies write to `stdout`; traces, prompts, and warnings write to `stderr`. Non-interactive runs (piped stdin or `--yes`) auto-approve writes. Exit codes: `0` success, `1` runtime/provider failure, `2` usage/config error, `130` aborted (`SIGINT`).

---

## Skills & Project Rules

### Skills (`.champ/skills/*.md` and `~/.champ/skills/*.md`)

Precedence: **workspace > user > built-in**. 8 built-ins ship out of the box: `/explain`, `/test`, `/refactor`, `/review`, `/commit`, `/doc`, `/fix`, `/optimize`.

```markdown
---
name: api-check
description: Review API handler validation and error codes
mode: ask
allowedTools: [read_file, grep_search]
---
Inspect `{{currentFile}}` ({{language}}). Focus on: {{userInput}}
```

Template variables: `{{userInput}}`, `{{workspaceRoot}}`, `{{date}}`, `{{currentFile}}`, `{{language}}`, `{{selection}}`, `{{cursorLine}}`, `{{branch}}`. Unknown `{{vars}}` are preserved literally.

CLI notes: editor-only variables (`{{selection}}`, `{{cursorLine}}`) resolve to empty strings (pass `--file <path>` for `{{currentFile}}`/`{{language}}`); `/commit` warns in CLI because `run_terminal_cmd` is extension-only; `/fix` expects editor diagnostics.

### Project Rules (`.champ/rules/*.md`)

```markdown
---
name: ts-strict
type: auto-attached   # always | auto-attached | agent-requested
glob: "src/**/*.ts"
---
Prefer composition and early returns.
```

Global `userRules` in `~/.champ/config.yaml` apply alongside `always` and matching `auto-attached` rules.

---

## Agent Teams & Custom Agents

### Custom Agents (`.champ/agents/*.md`)

Define reusable agents with YAML frontmatter (`name`, `role`, optional `outputKey`). Loaded automatically at startup and runnable via `Champ: Run Multi-Agent Workflow` or file-save `triggers:` in config.

### Agent Teams (`.champ/teams/*.yaml`)

Create from template (`DevOps Platform`, `Fullstack Feature`, `Code Review`, `Incident Response`) via **`Champ: Create Team from Template`** or run via **`Champ: Run Agent Team`**:

- Top-level keys: `name`, `description`, `version`, `defaults` (`model`, `maxTokens`, `temperature`), `execution` (`maxParallel`, `totalTokenBudget`, `timeoutSeconds`, `retries`, `checkpoints`, `mode: auto | safe | supervised`), and `agents[]`.
- Agent fields: `id`, `name`, `role`, `systemPrompt` (supports `{{outputKey}}` / `{{key.path}}`), `dependsOn`, `condition` (`== null`, `!= null`, `== true`, `== false`), `tools`, `model`, `maxTokens`, `outputKey`, `outputFormat: text | json | files`, `selfCritique`.
- Anti-hallucination protocol: agents unable to proceed respond with `BLOCKED: <reason>` (surfaced for Skip/Retry), wrap output in `<reasoning>...</reasoning><output>...</output>`, and can spawn dynamic helpers via `SPAWN:`.

Built-in DevOps workflows under `.champ/teams/devops-*.yaml`: Daily Standup (`devops-standup`), Task Routing (`devops-task-routing`), Incident Response (`devops-incident-response`, SEV1–SEV4), and Deployment/PR Review (`devops-deployment-review`).

---

## MCP Servers

Configure stdio/SSE servers in `~/.champ/config.yaml` under `mcp.servers` (`name`, `command`, `args`, `env: { KEY: "${env:KEY}" }`). Discovered tools appear as `mcp_<server>_<tool>`. Manage connections from the chat footer MCP panel or `Champ: Reload MCP Server`.

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Toggle Mode | `Cmd/Ctrl + Shift + M` |
| Inline Edit | `Cmd/Ctrl + K Cmd/Ctrl + I` |
| Send Chat Message | `Cmd/Ctrl + Enter` (in input) |
| Accept / Dismiss Autocomplete | `Tab` / `Esc` |

---

## Troubleshooting

- **`champ: command not found`**: run `export PATH="$(npm config get prefix)/bin:$PATH"`.
- **`Cannot find module dist/cli.js`**: run `node esbuild.mjs`.
- **`no provider configured`**: run `champ setup`, migrate with `champ config migrate`, or pass `--provider`/`--base-url`.
- **Unreachable endpoint / 401**: run `champ provider test <id>`; check `baseUrl` (include `/v1` for OpenAI-compatible/vLLM/llama.cpp) and keyring/env credentials.
- **Model talks instead of calling tools**: ensure you selected an **Instruct** model ($\ge$7B for tool calling), not a base/tiny completion model (see [CONFIG.md](CONFIG.md#model-selection--hardware-guide)).
- **Tool calls repeat endlessly**: set `supportsTools: false` on endpoints that advertise tool schemas without compliant `tool_calls`.
- **Extension logs**: check VS Code **Output → Champ** or `Developer: Toggle Developer Tools`.
