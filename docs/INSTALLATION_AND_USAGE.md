# Champ Plugin: Installation and Usage Guide

Champ is an AI coding agent for VS Code with full local-LLM support. This guide covers installing the extension, installing and using the headless CLI, and configuring it for your environment.

## Table of Contents

- [Installation](#installation)
  - [VS Code Extension](#vs-code-extension)
  - [Headless CLI (no VS Code required)](#headless-cli-no-vs-code-required)
- [Configuration](#configuration)
  - [Config file locations and precedence](#config-file-locations-and-precedence)
  - [Quick config examples](#quick-config-examples)
  - [API keys](#api-keys)
- [Using the VS Code Extension](#using-the-vs-code-extension)
- [Using the Headless CLI](#using-the-headless-cli)
- [Troubleshooting](#troubleshooting)
- [Advanced Configuration](#advanced-configuration)

---

## Installation

### VS Code Extension

#### Option 1: Install from .vsix (offline/local)
```bash
code --install-extension champ-2.0.2.vsix
```

Or in VS Code: `Extensions > ... > Install from VSIX...` and select `champ-2.0.2.vsix`.

#### Option 2: Build from source
```bash
# Clone and install dependencies
git clone <repo-url>
cd vs-code-plugin
pnpm install

# Build the extension
pnpm run compile

# Package as .vsix
npx @vscode/vsce package --no-dependencies

# Install
code --install-extension champ-<version>.vsix
```

After installation, reload VS Code and you'll see the **Champ** icon in the activity bar.

### Headless CLI (no VS Code required)

The CLI is built into the repo and can be installed globally for single-command usage like `claude` or `opencode`.

#### Quick setup (recommended - verified working)
```bash
cd /path/to/vs-code-plugin

# Build the CLI
node esbuild.mjs

# Install globally (npm link)
npm link

# Configure to point at your local LLM (example for local OpenAI-compatible)
# The CLI reads from ~/.champ/config.yaml by default
```

Edit `~/.champ/config.yaml` (create it if it doesn't exist) to point to your endpoint. See [Configuration](#configuration) for details.

#### Alternative: Install from packed tarball
```bash
pnpm run compile  # builds dist/cli.js
npm pack           # creates champ-<version>.tgz
npm install -g ./champ-<version>.tgz
champ --version
```

#### Verify installation
```bash
which champ
champ --help
```

---

## Configuration

### Config file locations and precedence

Champ uses a single source of truth with the following precedence (highest to lowest):

1. **Workspace YAML** - `<repo>/.champ/config.yaml`
2. **User YAML** - `~/.champ/config.yaml`
3. **VS Code settings** - `champ.*` settings
4. **Defaults** - built-in

You can pin which source to use with the VS Code setting `champ.configSource` (`workspace-yaml` | `user-yaml` | `settings`). Use `Champ: Show Effective Config` in VS Code to see the merged result and where each value comes from.

### Quick config examples

#### Local OpenAI-compatible server (e.g., LMStudio, vLLM, mlx-serve)
```yaml
# ~/.champ/config.yaml or <repo>/.champ/config.yaml
provider: openai-compatible

providers:
  openai-compatible:
    baseUrl: http://192.168.1.64:8080/v1
    model: Qwen3.5-4B-MLX-4bit
    apiKey: dummy  # Self-hosted doesn't require real key
    supportsTools: true  # Enable native function/tool calling

agent:
  yoloMode: false  # true to skip approval prompts
```

#### Ollama (local)
```yaml
provider: ollama

providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    model: qwen2.5-coder:7b
```

#### Cloud providers (API keys via SecretStorage)
```yaml
provider: claude

# API keys stored securely - set via: Champ: Set API Key
# or env var: export ANTHROPIC_API_KEY=sk-...
```

For all options, see [`docs/CONFIG.md`](./CONFIG.md).

### API keys

- **Cloud providers**: Never put API keys in YAML. Store them securely via `Champ: Set API Key` command in VS Code, or set environment variables.
- **Local/OpenAI-compatible**: Often no key needed; use `apiKey: dummy` if the server requires one.

---

## Using the VS Code Extension

1. **Open Champ**: Click the Champ icon in the Activity Bar
2. **Select provider/model**: Use the model picker or configure via YAML
3. **Choose mode**: Agent (autonomous), Ask (Q&A), Manual, Plan, Composer
4. **Chat**: Use `@` symbols for context (`@Files`, `@Codebase`, `@Git`, `@Terminal`, etc.)
5. **Approve actions**: In Agent mode, destructive actions will prompt for approval unless `yoloMode: true`

**Useful commands** (Command Palette `Ctrl+Shift+P` / `Cmd+Shift+P`):
- `Champ: Show Effective Config` - View merged config
- `Champ: Rescan Models` - Discover models from all providers
- `Champ: Set API Key` - Store cloud API key securely
- `Champ: Index Workspace` - Build/rebuild RAG index
- `Champ: Verify Audit Log` - Validate security audit trail

---

## Using the Headless CLI

The CLI provides the same agent capabilities without VS Code. Perfect for automation, CI, or local scripting.

### Basic usage

```bash
cd /your/project

# One-shot task
champ "list all TypeScript files and summarize the project structure"

# Interactive REPL
champ

# Pipe from stdin
echo "explain src/index.ts" | champ

# Resume a previous session
champ --session <session-id> "continue from where we left off"
```

### Flags

| Flag | Description |
|------|-------------|
| `-y, --yes` | Auto-approve all tool calls (required for non-interactive use) |
| `-r, --repl` | Force interactive REPL mode |
| `--cwd <dir>` | Set working directory |
| `--provider <name>` | Override provider from config |
| `--base-url <url>` | Override base URL |
| `--model <id>` | Override model |
| `--api-key <key>` | Override API key |
| `--session <id>` | Resume a specific session |
| `--max-iter <n>` | Set max agent iterations |
| `-` | Read task from stdin explicitly |

### Session management

```bash
# List sessions
champ --sessions

# Resume latest session automatically (just run champ again in same dir)
champ "continue the task"
```

Sessions are stored in `<cwd>/.champ/sessions/` as append-only JSONL logs.

### Output behavior

- **Agent replies** go to `stdout` (so you can pipe them: `champ "..." > result.md`)
- **Traces/logs** go to `stderr`
- **In non-interactive mode** (piped stdin or one-shot without TTY), destructive tools are auto-approved with a notice to stderr

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `champ: command not found` | Run `npm link` from the repo, or ensure global npm bin is in PATH. Check with `which npm && npm config get prefix`. |
| `Cannot find module dist/cli.js` | Build the CLI: `node esbuild.mjs`. If you used `npm link`, rebuild after source changes. |
| `no provider configured` | Set up `~/.champ/config.yaml` or use `--provider`/`--base-url` flags. Check with `champ "test"` - it will show config errors. |
| Repeats tool calls forever | Enable `supportsTools: true` for OpenAI-compatible servers, or use a provider with native tool support. |
| Server unreachable | Verify endpoint: `curl http://your-server:8000/v1/models`. Check firewall/network. |
| Permission denied on approval | Use `-y` flag for non-interactive runs, or run in interactive terminal. |
| Context window issues | The CLI auto-detects from server; if wrong, set in config or let it detect. |

---

## Advanced Configuration

### Environment variables
- `CHAMP_CONFIG` - Override config file path
- Provider API keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.

### Smart Routing
Configure per-task model selection:
```yaml
routing:
  mode: smart  # or "manual"
  coding: claude-sonnet-4-20250514
  chat: gpt-4o-mini
  embedding: ollama:nomic-embed-text
```

### Codebase indexing (RAG)
```yaml
indexing:
  enabled: true
  embeddingProvider: ollama
  ignore:
    - node_modules/**
    - dist/**
    - .git/**
```

### MCP servers
```yaml
mcp:
  servers:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: ${env:GITHUB_TOKEN}
```

---

For more details, see:
- [README.md](../README.md) - Full feature overview
- [docs/CONFIG.md](./CONFIG.md) - Complete configuration reference
- [docs/USER_GUIDE.md](./USER_GUIDE.md) - In-depth usage guide
- [docs/SETUP_GUIDE.md](./SETUP_GUIDE.md) - Detailed setup instructions
