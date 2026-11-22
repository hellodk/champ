# Installation and Usage Guide

This guide is written for beginners. No root/admin access is required. You can install everything in your user directory and add it to your `PATH` if needed.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [1) Install the VS Code Extension (Plugin)](#1-install-the-vs-code-extension-plugin)
- [2) Install the Champ CLI (Terminal)](#2-install-the-champ-cli-terminal)
- [3) Configure the CLI to use your model](#3-configure-the-cli-to-use-your-model)
- [4) Using the VS Code Extension](#4-using-the-vs-code-extension)
- [5) Using the Champ CLI](#5-using-the-champ-cli)
- [6) Updating](#6-updating)
- [7) Troubleshooting](#7-troubleshooting)
- [8) Notes for Beginners](#8-notes-for-beginners)

---

## Overview

Champ has two parts:

| Part | What it is | Where it runs |
|---|---|---|
| **VS Code Extension ("Plugin")** | Champ inside VS Code's sidebar/chat. | VS Code |
| **Champ CLI** | Run Champ from any terminal like `claude` or `opencode`. | Terminal/CI/scripts (no VS Code required) |

There is **no standalone desktop app executable**. Both run with Node.js.

---

## Prerequisites

Before you start, make sure you have:

1. **Node.js** (version 20 or newer)
   - Check: `node --version`
   - If missing, download from [nodejs.org](https://nodejs.org/) or use a version manager ([nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm)) in your user directory (no root needed).

2. **VS Code** (only if you want the extension)
   - Download from [code.visualstudio.com](https://code.visualstudio.com/)

3. **A model/provider** (local or cloud)
   - Local: [Ollama](https://ollama.com/), [LMStudio](https://lmstudio.ai/), [vLLM](https://github.com/vllm-project/vllm), [mlx-serve](https://github.com/ml-explore/mlx-examples), etc.
   - Cloud: Anthropic/OpenAI/Gemini/etc. (API keys go in SecretStorage or env vars, never committed to YAML)

4. **(For building from source)** [pnpm](https://pnpm.io/installation)
   - Check: `pnpm --version`
   - Can be installed per-user with `npm install -g pnpm` or via `corepack enable`

---

## 1) Install the VS Code Extension (Plugin)

### Option A: Install from a `.vsix` file (easiest)

If you have a `champ-*.vsix` file (downloaded or built):

**From terminal:**
```bash
code --install-extension /path/to/champ-<version>.vsix
```

**From VS Code UI:**
1. Open VS Code
2. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
3. Run `Extensions: Install from VSIX...`
4. Pick your `champ-*.vsix` file
5. Reload VS Code when prompted

The Champ icon will appear in the Activity Bar.

### Option B: Build from source

```bash
# Get the source code
git clone <your-repo-url>
cd <repo-folder>

# Install dependencies
pnpm install

# Build and package
pnpm run compile
npx @vscode/vsce package --no-dependencies

# Install the generated .vsix
code --install-extension champ-*.vsix
```

---

## 2) Install the Champ CLI (Terminal)

You can run the CLI in a few ways. Pick one.

### Option A: `npm link` (recommended, single command `champ`)

This creates a user-accessible command without needing root.

```bash
# Go to the repo
cd <repo-folder>

# Build the CLI
node esbuild.mjs

# Link it to your user npm prefix
npm link
```

Now `champ` should be available. If your terminal says "command not found", see [7) Troubleshooting](#7-troubleshooting) for adding your npm global bin to `PATH`.

### Option B: Install from a tarball (no repo symlink needed)

```bash
cd <repo-folder>
node esbuild.mjs --production
npm pack
npm install -g ./champ-<version>.tgz
```

### Option C: Run directly with Node (no global install)

Great for trying it out or on restricted systems.

```bash
cd <repo-folder>
node esbuild.mjs
node dist/cli.js --cwd /path/to/your/project -y "List the files"
```

**Verify:**
```bash
which champ
champ --version
```

---

## 3) Configure the CLI to use your model

The recommended way to configure Champ is the interactive setup wizard — you do **not** need to hand-edit YAML:

```bash
champ setup
```

`champ setup` lets you pick a provider (Anthropic Claude, OpenAI, Google Gemini, Ollama, llama.cpp, vLLM, or OpenAI-compatible such as MLX / LM Studio), enter your endpoint URL, enter an API key if the server requires one, automatically discover available models, and choose a default endpoint.

### Managed Registry and Secret Storage

- **Endpoint registry:** `~/.champ/providers.json` (managed automatically by `champ setup`, `champ provider ...`, and VS Code's `Champ: Configure Provider` — do not hand-edit).
- **Optional workspace reference:** `<your-project>/.champ/provider.json` (created by `champ model use <endpoint-id>/<model> --workspace`). Contains only non-secret endpoint/model references so projects can share model preferences safely.
- **Credential stores (host-separated, same logical IDs):**
  - **CLI:** stores keys in your OS keyring (`security` on macOS, `secret-tool` on Linux when a D-Bus session is running) or falls back to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `VLLM_API_KEY`, `OLLAMA_API_KEY`, etc.). Secrets are never written to JSON or plaintext files.
  - **VS Code extension:** stores keys in VS Code's encrypted `SecretStorage`.
- **Migrating an older `~/.champ/config.yaml`:**

```bash
champ config migrate --dry-run   # preview
champ config migrate             # import URLs/models without moving secrets into JSON
```

- **Scripted / CI overrides:** pass `--provider`, `--base-url`, `--model`, `--api-key` on the CLI (explicit flags always override the registry), or set `CHAMP_CONFIG=/path/to/config.yaml` when testing legacy YAML configs.

### Managing Endpoints and Models

```bash
# List configured endpoints (keys are never printed)
champ provider list

# Test connectivity and latency for an endpoint
champ provider test <endpoint-id>

# Discover or list available models
champ models
champ models refresh

# Switch the default model (or pin one to the current workspace)
champ model use <endpoint-id>/<model-id>
champ model use <endpoint-id>/<model-id> --workspace

# Inspect redacted configuration state
champ config show
```

### PATH Setup (when `champ` is not found)

Install with `npm link` (no `sudo` required). If your shell reports `champ: command not found`, add your user npm prefix's `bin` directory to `PATH`:

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

Add that line to `~/.bashrc` or `~/.zshrc` and reload your shell.

---

## 4) Using the VS Code Extension

1. Open your project in VS Code
2. Click the **Champ** icon in the Activity Bar
3. Pick your provider/model (or let it use your config)
4. Choose a mode: `Agent`, `Ask`, `Plan`, etc.
5. Chat with `@Files`, `@Codebase`, `@Git`, etc. for context
6. In Agent mode, you'll be asked to approve destructive actions unless `yoloMode: true`

Useful commands (`Ctrl+Shift+P` / `Cmd+Shift+P`):
- `Champ: Show Effective Config` - See what config is actually being used
- `Champ: Rescan Models` - Re-discover models from configured servers
- `Champ: Set API Key` - Store cloud keys securely

---

## 5) Using the Champ CLI

Run from any project directory:

```bash
cd /path/to/your/project
```

### Common commands

```bash
# One-shot task
champ "List all files and summarize this repo"

# Interactive REPL (like claude/opencode)
champ

# Pipe a prompt
echo "Explain src/index.ts" | champ

# Force REPL mode
champ --repl

# Resume latest session for this directory
champ "Continue where we left off"

# Resume a specific session
champ --session <session-id> "..."
```

### Useful flags

| Flag | Description |
|------|-------------|
| `-y`, `--yes` | Auto-approve tool calls (needed for non-interactive scripts) |
| `-r`, `--repl` | Start in REPL mode |
| `--cwd <dir>` | Set working directory |
| `--provider <name>` | Override provider |
| `--base-url <url>` | Override base URL (include `/v1` for OpenAI-compatible) |
| `--model <id>` | Override model ID |
| `--api-key <key>` | Override API key |
| `--session <id>` | Resume session |
| `--max-iter <n>` | Limit agent iterations |
| `-` | Read task from stdin explicitly |

### Override example (no config change)
```bash
champ \
  --provider openai-compatible \
  --base-url http://localhost:8000/v1 \
  --model <your-model-id> \
  --api-key dummy \
  -y "Find all TODO comments"
```

### Sessions
Sessions are saved in `<project>/.champ/sessions/`. Use `champ --sessions` to list them.

### Output
- **Answer** goes to `stdout` (easy to pipe to files)
- **Logs/traces** go to `stderr`

---

## 6) Updating

### Update the VS Code extension
Rebuild and reinstall the `.vsix`, or reinstall from the updated file.

### Update the CLI
```bash
cd <repo-folder>
git pull
node esbuild.mjs
# If using npm link, no extra install needed
# If installed from tarball, reinstall the new tarball
```

---

## 7) Skills and Project Rules

Champ supports reusable markdown skills and automatic project rules in both the VS Code extension and the headless CLI.

### Directory Layout

- `<workspace>/.champ/skills/*.md` — workspace skills (checked into git for the team; highest precedence)
- `~/.champ/skills/*.md` — personal user skills (override built-ins)
- `<workspace>/.champ/rules/*.md` — project rules (`always` or `auto-attached` by `glob`)
- `userRules:` in `~/.champ/config.yaml` — personal global rules always included in every turn

Precedence for same-named skills: **workspace > user > built-in**.

### Example Skill File

```markdown
---
name: api-check
description: Review an API handler for validation and error codes
mode: ask
allowedTools: [read_file, grep_search]
---

Check `{{currentFile}}` ({{language}}) for input validation and error handling.
Focus on: {{userInput}}
```

### Template Variables in the CLI

| Variable | CLI Value |
|---|---|
| `{{userInput}}` | Arguments after `/<skill>` or `--skill <name>` |
| `{{workspaceRoot}}` | Resolved `--cwd` directory |
| `{{date}}` | Today's ISO date (`YYYY-MM-DD`) |
| `{{currentFile}}` | Value passed to `--file <path>` (empty if omitted) |
| `{{language}}` | Derived from `--file` extension (empty if omitted/unknown) |
| `{{selection}}` | Empty in terminal (no editor) |
| `{{cursorLine}}` | Empty in terminal (no editor) |
| `{{branch}}` | Empty in terminal |

### CLI Commands and Flags

```bash
# List all available skills (no LLM endpoint needed)
champ --list-skills

# Run a skill in one-shot mode
champ -y "/review src/auth.ts"
champ -y --skill review "src/auth.ts"

# Attach file context for {{currentFile}}, {{language}}, and glob rules
champ -y --file src/auth.ts "/explain check token expiry"

# Ignore workspace/user skill directories (built-ins only)
champ --no-skills -y "just answer the question"
```

Inside the interactive REPL (`champ`), run `/skills` to list skills and `/<skill> [args]` to invoke one.

### Terminal Limitations (`/commit` and `/fix`)

- `/commit` declares `run_terminal_cmd`, which is not registered in the headless CLI; it runs with zero tools and warns on `stderr`.
- `/fix` expects editor LSP diagnostics, which are only available in the VS Code extension.

---

## 8) Troubleshooting

| Problem | Fix |
|---------|-----|
| `champ: command not found` | Your npm global bin isn't in `PATH`. Find it with `npm config get prefix` and add `$(npm config get prefix)/bin` to your shell config (`~/.bashrc`, `~/.zshrc`, etc.), then reload your shell. No sudo needed. |
| `Cannot find module dist/cli.js` | Build it: `node esbuild.mjs` in the repo folder. |
| `no provider configured` | Run `champ setup`, migrate existing YAML with `champ config migrate`, or pass `--provider`/`--base-url`. Run `champ --help` to see options. |
| Server unreachable | Run `champ provider test <id>`. Verify server URL, port, and firewall. |
| Model not found | Run `champ models refresh` and pick an exact ID with `champ model use <id>/<model>`. |
| Tool calls repeat forever | Your server may not support OpenAI-style tool calls. Try `supportsTools: false` or use a server that supports `tool_calls`. |
| Permission prompts in scripts | Add `-y` for non-interactive runs. |
| `code: command not found` | VS Code CLI not in PATH. Open VS Code, run `Shell Command: Install 'code' command in PATH` (macOS) or ensure VS Code is on PATH. |

---

## 9) Notes for Beginners

- **No root required.** Install Node in your user account, use `npm link` without `sudo`, and put configs in `~/.champ/`.
- **Use user config for convenience.** Put `~/.champ/config.yaml` in your home directory so `champ` works from any project.
- **Keep keys safe.** Never commit API keys to git. Use SecretStorage or environment variables.
- **Start simple.** Try Option C (run with Node directly) first to test, then switch to `npm link` for convenience.
- **Configs are generic.** Replace host/port/model with your own values — nothing here is hardcoded to a specific machine.
- **Rebuild on changes.** If you modify source code, run `node esbuild.mjs` to update `dist/cli.js`.
