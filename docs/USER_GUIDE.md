# Champ — User Guide

A complete walkthrough of the Champ chat experience, from first install to advanced workflows.

## Table of Contents

1. [Installation](#installation)
2. [First run and provider setup](#first-run-and-provider-setup)
3. [The chat sidebar](#the-chat-sidebar)
4. [Modes](#modes)
5. [Tools and approvals](#tools-and-approvals)
6. [Inline autocomplete](#inline-autocomplete)
7. [@-symbols for context](#-symbols-for-context)
8. [Checkpoints](#checkpoints)
9. [Rules](#rules)
10. [MCP servers](#mcp-servers)
11. [Keyboard shortcuts](#keyboard-shortcuts)
12. [Troubleshooting](#troubleshooting)

---

## Installation

### From the VS Code Marketplace (once published)

1. Open the Extensions view (`Cmd/Ctrl + Shift + X`).
2. Search for **Champ**.
3. Click **Install**.

### From a local `.vsix` (during development)

```bash
code --install-extension champ-0.1.0.vsix
```

### From source

```bash
git clone <repo-url>
cd vs-code-plugin
npm install
# Press F5 to launch an Extension Development Host
```

---

## First run and provider setup

After install, click the **Champ** icon in the Activity Bar (left sidebar). The chat panel opens with a welcome message. Before sending your first message you need to configure an LLM provider.

### Option A — Local (privacy-preserving, no API costs)

**Ollama** is the fastest path to a working local setup.

1. Install Ollama from <https://ollama.com>.
2. Pull the models:
   ```bash
   ollama pull llama3.1                # main chat/agent model
   ollama pull qwen2.5-coder:1.5b      # small model for inline completions
   ```
3. In VS Code settings (`Cmd/Ctrl + ,`), search for `champ`:
   - `champ.provider` → `ollama`
   - `champ.ollama.model` → `llama3.1`
   - `champ.ollama.baseUrl` → `http://localhost:11434` *(default, leave as-is)*
   - `champ.autocomplete.model` → `qwen2.5-coder:1.5b`

**llama.cpp** works identically if you prefer:
```bash
./llama-server -m your-model.gguf --port 8080
```
- `champ.provider` → `llamacpp`
- `champ.llamacpp.baseUrl` → `http://localhost:8080/v1` *(default)*

**vLLM** for GPU inference:
- `champ.provider` → `vllm`
- `champ.vllm.baseUrl` → `http://localhost:8000/v1`
- `champ.vllm.model` → your served model name

### Option B — Cloud (best quality, requires API key)

**Claude** (recommended):
1. Get an API key from <https://console.anthropic.com>.
2. Set `champ.provider` → `claude`.
3. Run the command `Champ: Set Claude API Key` *(or configure via SecretStorage)*.

**OpenAI**:
- `champ.provider` → `openai`
- `champ.openai.model` → `gpt-4o`
- Store the API key via SecretStorage key `champ.openai.apiKey`

**Gemini**:
- `champ.provider` → `gemini`
- `champ.gemini.model` → `gemini-2.0-flash`
- Store the API key via SecretStorage key `champ.gemini.apiKey`

### Option C — Any OpenAI-compatible endpoint

Covers LM Studio, text-generation-webui, and self-hosted proxies:
- `champ.provider` → `openai-compatible`
- `champ.openaiCompatible.baseUrl` → your URL (e.g. `http://your-server:9000/v1`)
- `champ.openaiCompatible.model` → your model name
- `champ.openaiCompatible.apiKey` → optional

---

## The chat sidebar

The sidebar has three sections, top to bottom:

```
┌─────────────────────────────────────┐
│ [Agent ▾]              [New Chat]   │  ← toolbar
├─────────────────────────────────────┤
│                                     │
│  assistant                          │
│  ┌─────────────────────────────┐   │
│  │ Sure, I'll read main.ts     │   │
│  │                             │   │
│  │ 🔧 read_file                │   │  ← tool card
│  │   {"path": "src/main.ts"}   │   │
│  │   → file contents...        │   │
│  └─────────────────────────────┘   │
│                                     │  ← message list
├─────────────────────────────────────┤
│  Ask Champ anything...              │
│                                     │
│                  [Cancel] [Send]    │  ← input
└─────────────────────────────────────┘
```

- **Toolbar**: mode switcher (left) and New Chat button (right).
- **Message list**: scrolling history of user and assistant messages with inline tool cards.
- **Input**: multi-line textarea with `Cmd/Ctrl + Enter` to send and a Cancel button that appears while the agent is running.

Messages stream character-by-character as the model generates. A blinking cursor appears on the active assistant message until streaming completes.

---

## Modes

Change mode via the dropdown in the toolbar or with `Cmd/Ctrl + Shift + M`.

### Agent (default)

Autonomous multi-step execution. The agent proactively uses its tools to complete your request end-to-end. It can read files, edit them, run terminal commands, and iterate on errors — all without asking for permission on every step.

**Best for**: "Fix this bug", "Add a test for this function", "Refactor the auth module to use JWT".

### Ask

Read-only Q&A. The agent can use `read_file`, `list_directory`, `grep_search`, `codebase_search`, and `file_search` to answer questions, but it cannot modify any files or run commands.

**Best for**: "How does authentication work in this codebase?", "Where is the rate limiter implemented?", "Explain this function".

### Manual

Step-by-step with explicit approval per tool call. Before executing any action, the agent explains what it plans to do and waits for your approval. Use this when you want to be in the loop on every decision.

**Best for**: Learning how the agent works, high-stakes changes, unfamiliar codebases.

### Plan

Research and produce a detailed plan without making edits. The agent reads the codebase, understands the current state, and produces a numbered list of proposed changes for your review.

**Best for**: Architectural changes, large refactors, any work you want to review before execution.

### Composer

Multi-file edit workflow with a Plan → Diff → Apply cycle and git integration. The composer produces diffs for all affected files at once, shows them in a review interface with per-file accept/reject, and can auto-commit to a new branch.

**Best for**: Coordinated changes across many files, bulk refactors, anything you want to roll back cleanly.

---

## Tools and approvals

The agent has 10 built-in tools:

| Tool | Description | Requires approval |
|------|-------------|-------------------|
| `read_file` | Read a file with line numbers | No |
| `list_directory` | List directory contents | No |
| `grep_search` | Regex search via ripgrep | No |
| `file_search` | Fuzzy file name search | No |
| `edit_file` | Replace content in a file | **Yes** |
| `create_file` | Create a new file | **Yes** |
| `delete_file` | Delete a file | **Yes** |
| `run_terminal_cmd` | Execute a shell command | **Yes** |

When a tool requires approval, a dialog appears in the chat asking you to confirm before execution. **YOLO mode** can disable approvals (`champ.yoloMode: true`) — use with caution.

### Safety layer

All terminal commands pass through a sandbox that blocks obviously dangerous operations:
- `rm -rf /` and variants
- `mkfs`, `dd if=... of=/dev/...`
- `curl ... | bash`, `wget ... | bash`
- `sudo` (disabled by default)
- Fork bombs and chmod 777 on root

Before sending file contents or terminal output to the LLM, a secret scanner redacts:
- PEM private keys
- AWS access keys
- Anthropic, OpenAI, Gemini, GitHub, Slack tokens
- Password and API key assignments in env files

---

## Inline autocomplete

As you type in any file, Champ sends the surrounding context to a small fast local model and displays the suggestion as ghost text after the cursor. Press `Tab` to accept, `Esc` to dismiss.

Configuration:
- `champ.autocomplete.enabled` — master switch (default `true`)
- `champ.autocomplete.debounceMs` — pause before triggering (default `300`)
- `champ.autocomplete.model` — small model name (default `qwen2.5-coder:1.5b`)

Autocomplete is routed separately from chat via the `ModelRouter` — you can use Claude for agent chat and a local Qwen model for autocomplete simultaneously.

---

## @-symbols for context

Type `@` in the chat input to inject context references into your message:

| Symbol | Example | Resolves to |
|--------|---------|-------------|
| `@Files(path)` | `@Files(src/main.ts)` | File contents |
| `@Folders(path)` | `@Folders(src/utils)` | Recursive directory listing |
| `@Code` | `@Code` | Current editor selection |
| `@Symbols(name)` | `@Symbols(AuthService)` | Workspace symbol |
| `@Codebase` | `@Codebase how does auth work?` | Semantic vector search |
| `@Web` | `@Web latest React patterns` | Web search results |
| `@Git` | `@Git show recent changes` | Git diff / history |
| `@Docs(name)` | `@Docs(react-router)` | Library documentation |

Multiple references can be mixed in one message: `Compare @Files(a.ts) with @Files(b.ts) using @Codebase search`.

---

## Checkpoints

Before any destructive agent action (file edit, create, delete, terminal command), Champ snapshots the affected files. You can restore to any prior checkpoint via the **Restore Checkpoint** command.

Snapshots are kept in memory per session and do not touch your git history, so they work even in non-git repositories.

---

## Rules

Project-level rules live in `.champ/rules/*.md`. Each file is a Markdown document with optional YAML frontmatter:

```markdown
---
name: typescript-style
type: auto-attached
glob: "*.ts"
---

Use 2-space indentation.
Prefer `const` over `let`.
Always write JSDoc for exported functions.
```

Rule types:
- `always` — attached to every request
- `auto-attached` — attached when the current file matches `glob`
- `agent-requested` — not auto-attached; the agent fetches by name

User-wide rules are a single free-form string in `champ.userRules`.

---

## MCP servers

Champ supports [Model Context Protocol](https://modelcontextprotocol.io) servers for extending the agent with external tools (GitHub, Slack, databases, internal APIs).

Configure via `champ.mcp.servers`:

```json
{
  "champ.mcp.servers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" }
    }
  ]
}
```

Registered MCP tools appear alongside built-in tools with the prefix `mcp_<servername>_<toolname>`.

---

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| New chat | `Cmd/Ctrl + Shift + L` |
| Toggle mode | `Cmd/Ctrl + Shift + M` |
| Send message | `Cmd/Ctrl + Enter` in the chat input |
| Accept inline completion | `Tab` |
| Dismiss inline completion | `Esc` |
| Open settings | `Champ: Settings` command |

---

## Troubleshooting

### "Champ: failed to initialize LLM provider"
- For Claude/OpenAI/Gemini: verify the API key is stored in SecretStorage.
- For Ollama: ensure `ollama serve` is running (`curl http://localhost:11434/api/tags`).
- For llama.cpp: ensure the server started with `./llama-server -m <model>.gguf`.

### Chat shows "Connection refused"
- Local model isn't running. Check the `baseUrl` setting matches your server.

### Agent loops or hangs
- Press **Cancel** in the input area, or run `Champ: New Chat`.
- Check the model supports tool calling (see the [provider support matrix](ARCHITECTURE.md)).
- For small local models without native tool use, the XML fallback kicks in automatically but may be slower to parse.

### Inline autocomplete doesn't appear
- Check `champ.autocomplete.enabled` is `true`.
- Verify the small model is pulled (`ollama list`).
- Wait for the debounce delay (default 300ms after typing stops).

### Too many false secrets redacted
- The secret scanner uses regex patterns that can false-positive on long base64 strings. If this is a problem, file an issue with the specific pattern that's misfiring.

### High latency on local models
- Try a smaller quantization (Q4_K_M vs Q8_0).
- Use `qwen2.5-coder:1.5b` for autocomplete instead of a large chat model.
- On Apple Silicon, ensure Metal acceleration is enabled in your Ollama/llama.cpp build.

### The extension doesn't activate
- Check the VS Code Output panel → "Champ" for activation errors.
- Run `Developer: Toggle Developer Tools` to see webview console errors.

---

## Feedback

File issues or feature requests at the project's GitHub repository. Include:
- Champ version (`champ-0.1.0`)
- VS Code version
- Provider name and model
- Reproduction steps
