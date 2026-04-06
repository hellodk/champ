# AIDev — AI Coding Agent for VS Code

Open-source VS Code extension that delivers a Cursor-like AI coding experience with multi-agent orchestration, full local LLM support, and strong safety controls. Built in pure TypeScript with a TDD-first workflow.

## Features

- **Multi-agent orchestration** — Planner, Code, Reviewer, Validator, Context, and File agents coordinate through a shared memory system with retry and conditional branching.
- **7 LLM providers behind one interface** — Claude, OpenAI, Gemini, Ollama, llama.cpp, vLLM, and any OpenAI-compatible endpoint. Switch providers in settings without restart.
- **Local-first** — Run entirely offline on Apple Silicon 16GB with Ollama + Qwen2.5-Coder or Llama 3.1. No cloud dependency.
- **Sidebar chat with streaming** — Agent / Ask / Manual / Plan / Composer modes, live token streaming, and collapsible tool-call cards.
- **10 built-in tools** — `read_file`, `edit_file`, `create_file`, `delete_file`, `list_directory`, `run_terminal_cmd`, `grep_search`, `file_search`, plus per-tool approval flow.
- **Inline autocomplete** — Ghost-text suggestions via a small fast local model with microtask debouncing for low latency.
- **Codebase indexing** — AST-aware chunking (functions, classes) and vector search over the whole workspace.
- **Composer mode** — Multi-file edits with Plan → Diff → Apply workflow and git auto-branch/commit/rollback.
- **Checkpoints** — Shadow-copy snapshots before each agent action so any change is reversible.
- **Safety layer** — Command sandbox (blocks `rm -rf /`, `curl | bash`, etc.), secret scanner (redacts API keys before sending to LLM), path traversal protection.
- **Auto-fix loop** — Detects LSP diagnostic errors after edits and iterates up to 3 times to resolve them.
- **@-symbols for context injection** — `@Files`, `@Folders`, `@Codebase`, `@Web`, `@Git`, `@Docs`, `@Code`, `@Symbols`.
- **Rules engine** — Project (`.aidev/rules/*.md`), user, and team rules with glob-based auto-attach.
- **MCP support** — Extend the agent with external Model Context Protocol servers.
- **Observability** — Per-request latency, token usage, agent step logs, and tool call metrics.

## Quick start

### Install

**From VSIX** (during development):
```bash
code --install-extension aidev-0.1.0.vsix
```

**From Marketplace**: (once published) search "AIDev" in the Extensions view.

### Configure a provider

Open settings (`Cmd/Ctrl + ,`) and search for `aidev`. Pick one:

**Cloud (Claude)**
- Set `aidev.provider` to `claude`
- Store your API key via the command palette: `AIDev: Set API Key` *(or set `aidev.claude.apiKey` as a workspace-level secret via SecretStorage)*

**Local (Ollama)** — recommended for privacy
```bash
# Install Ollama from https://ollama.com
ollama pull llama3.1
ollama pull qwen2.5-coder:1.5b  # for inline autocomplete
```
- Set `aidev.provider` to `ollama`
- `aidev.ollama.model` to `llama3.1`
- `aidev.autocomplete.model` to `qwen2.5-coder:1.5b`

**Local (llama.cpp)**
```bash
# Build llama.cpp with server support, then:
./llama-server -m your-model.gguf --port 8080
```
- Set `aidev.provider` to `llamacpp`

Supported providers: `claude`, `openai`, `gemini`, `ollama`, `llamacpp`, `vllm`, `openai-compatible`.

### Use

1. Click the **AIDev** icon in the Activity Bar to open the chat sidebar.
2. Pick a mode from the dropdown:
   - **Agent** — autonomous multi-step execution
   - **Ask** — read-only Q&A
   - **Manual** — step-by-step with approval per tool
   - **Plan** — research and produce a plan without edits
   - **Composer** — multi-file edits with diff review
3. Type your request. `Cmd/Ctrl + Enter` to send.
4. Watch streaming responses and tool cards as the agent works.

### Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `AIDev: New Chat` | `Cmd/Ctrl + Shift + L` | Start a fresh conversation |
| `AIDev: Toggle Mode` | `Cmd/Ctrl + Shift + M` | Switch between Agent/Ask/Manual/Plan/Composer |
| `AIDev: Index Workspace` | — | Build the embedding index for semantic search |
| `AIDev: Restore Checkpoint` | — | Roll back to a prior agent action |
| `AIDev: Settings` | — | Jump to AIDev settings |

## Documentation

- **[User Guide](docs/USER_GUIDE.md)** — detailed usage walkthrough, mode comparison, tips
- **[Architecture](docs/ARCHITECTURE.md)** — full system design, module breakdown, data flows
- **[System Prompts](docs/SYSTEM_PROMPTS.md)** — every prompt the extension sends to the LLM
- **[API Reference](docs/API_REFERENCE.md)** — TypeScript interfaces for every module
- **[Implementation Roadmap](docs/IMPLEMENTATION_ROADMAP.md)** — 10-phase build plan
- **[Setup Guide](docs/SETUP_GUIDE.md)** — developer setup, local LLM configuration, testing
- **[Publishing Guide](docs/PUBLISHING.md)** — how to package and publish to the marketplace
- **[Ground Rules](GROUND_RULES.md)** — TDD and test automation requirements

## Development

```bash
# Clone and install
git clone <repo-url>
cd vs-code-plugin
npm install

# Run tests (306 tests across 44 files)
npm test

# Typecheck
npm run check-types

# Build extension bundle
npm run compile

# Launch Extension Development Host
# In VS Code: press F5 (or Run > Start Debugging)
```

### Project structure

```
src/
├── agent/            Multi-agent orchestration + controller + auto-fix + context resolver
├── providers/        7 LLM providers + registry + factory + context mgr + model router
├── tools/            10 tools + registry with approval flow
├── safety/           Command sandbox + secret scanner
├── completion/       Ghost-text inline autocomplete
├── indexing/         AST chunking + vector store
├── composer/         Plan→Diff→Apply multi-file workflow
├── upload/           File ingestion + session memory
├── checkpoints/      Shadow-copy snapshots
├── rules/            Project + user rules engine
├── mcp/              MCP server manager
├── observability/    Metrics collector
├── prompts/          System prompt builder
├── ui/               Webview protocol + ChatViewProvider
├── utils/            Workspace path protection
└── extension.ts      Activation wiring
```

### TDD policy

**Every feature is test-first.** See [`GROUND_RULES.md`](GROUND_RULES.md). Current stats:
- 306 tests across 44 test files
- 100% of implementation files have a corresponding test file
- Post-commit git hook generates a named JSON test report per commit

### Architecture highlights

- **Provider abstraction**: one `LLMProvider` interface; every backend (Claude, OpenAI, Gemini, Ollama, llama.cpp, vLLM) is plug-compatible.
- **Model routing**: small model for autocomplete, large model for chat — different providers per task.
- **Prompt-based tool calling**: models without native tool use get tools injected via XML in the system prompt; the agent loop never knows the difference.
- **Workspace-scoped path protection**: every tool resolves user-supplied paths through a shared `resolveInWorkspace` helper that rejects traversal attempts.
- **Zero native dependencies**: in-memory vector store, regex-based chunking, fetch-based HTTP — runs on every platform VS Code supports without platform-specific binaries.

## License

MIT © AIDev contributors. See [`LICENSE`](LICENSE).

## Contributing

Contributions are welcome. Requirements:
1. Write a failing test first (see `GROUND_RULES.md`)
2. Implement until green
3. `npm run check-types` must pass
4. `npm test` must pass

## Acknowledgments

Draws inspiration from the open-source patterns of Continue.dev (chat context), Cline (agent workflows), Aider (diff application), and Codeium (autocomplete UX). None of their code is used directly; only architectural patterns.
