# Changelog

All notable changes to AIDev will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-04-06

### Fixed

- **Local models can now actually use tools.** AgentController now wires
  the prompt-based-tools fallback designed in Phase 1: when the active
  provider returns `supportsToolUse() === false` (Ollama, llama.cpp,
  vLLM, or any OpenAI-compatible endpoint without native tool calling),
  the agent injects the tool catalog as XML into a system message and
  parses `<tool_call>` blocks from the response text. Tool results are
  fed back as `<tool_result>` blocks on the next user turn. Previously
  the model would just describe what to do — never actually creating
  files or running commands.
- **Agent now has system prompt instructions.** AgentController prepends
  base instructions telling the model it is "AIDev, an autonomous AI
  coding assistant" and that it MUST use tools instead of describing
  actions. Without this the model would helpfully explain the steps
  but never take them.
- **`<tool_call>` XML stripped from user-visible chat output.** The
  buffered text is parsed for tool calls, then the cleaned prose (with
  XML removed) is emitted to the chat panel as a single delta.

### Added

- **`requestApproval` callback in `ProcessMessageOptions`** so the chat
  view can pipe approval prompts through the webview instead of using
  the default auto-approve.
- 4 new regression tests covering the prompt-based-tool flow:
  parsing tool calls from XML, sending tool results back, system prompt
  injection, and clean fallthrough when no tool is called.
- 313 tests passing (up from 309).

## [0.1.1] — 2026-04-06

### Fixed

- **Activation no longer crashes when an API key is missing.** Previously,
  if the user installed the extension and tried to configure llama.cpp,
  Ollama, or another provider, activation would fail because the default
  `aidev.provider` was `claude` and `new Anthropic({apiKey: undefined})`
  throws synchronously. The chat view, commands, and inline completion
  weren't registered as a result, leaving the user with no UI to fix the
  problem. ClaudeProvider, OpenAIProvider, and GeminiProvider now lazy-init
  their SDK clients on first use.
- **Extension activation never returns early on provider failure.** The
  chat view, commands, status bar, and inline completion are always
  registered. Provider load failures now appear inside the chat panel as
  an actionable error instead of silently breaking everything.
- **Tools are no longer sent to providers that don't support tool calling.**
  AgentController now checks `provider.supportsToolUse()` and only passes
  tool definitions when the provider can actually use them — fixes confusing
  outputs from local models like Qwen2.5-Coder base.
- **`/v1/completions` endpoint used for autocomplete.** OpenAICompatibleProvider
  (and llama.cpp / vLLM) now hit the legacy `/v1/completions` endpoint for
  inline completion instead of wrapping the prompt in `/v1/chat/completions`.
  This matters for completion-only base models where the chat template
  produces awkward output. Falls back to chat if `/v1/completions` returns 404.
- **SSE parser handles both chat and legacy completions response shapes**
  (`choices[0].delta.content` and `choices[0].text`).

### Added

- **Status bar item** showing the active provider, click to open settings.
- **`AIDev: Set API Key` command** for storing API keys in SecretStorage
  without editing JSON.
- **Hot-swap provider on settings change** — `AgentController` and
  `AidevInlineCompletionProvider` now expose `setProvider()` so the
  extension can swap providers at runtime without re-initializing.
- **Stub provider** used as a placeholder during activation; emits a
  clear "no provider configured" error in the chat instead of crashing.

### Tests

- 309 tests passing (up from 306) — added 3 regression tests for
  ClaudeProvider lazy initialization.

## [0.1.0] — 2026-04-06

### Added

Initial release covering the full 10-phase implementation:

#### Phase 1 — Provider foundations
- `LLMProvider` interface with streaming chat, streaming complete, tool use, token counting
- `ClaudeProvider` (Anthropic SDK) with tool_use streaming
- `OllamaProvider` (native `/api/chat` and `/api/generate`)
- `ProviderRegistry` with register/get/list/dispose
- `ContextWindowManager` with token-aware message truncation
- Prompt-based tool injection/parsing (XML) for models without native tool_use
- `MetricsCollector` tracking latency, tokens, agent steps, tool calls, failures
- `SystemPromptBuilder` with base prompt + 5 mode appends + rules injection

#### Phase 2 — Tool system
- `ToolRegistry` with approval flow and error handling
- File tools: `read_file`, `edit_file`, `create_file`, `delete_file`, `list_directory`
- Search tools: `grep_search` (bundled ripgrep), `file_search` (findFiles)
- Terminal tool: `run_terminal_cmd` with spawn, timeout, sandbox, progress streaming
- `CommandSandbox` blocking `rm -rf /`, `curl|bash`, sudo, etc.
- `SecretScanner` redacting AWS/Anthropic/OpenAI/GitHub/Google/Slack keys and passwords
- `AgentController` single-agent loop with iteration limit and event emission
- `resolveInWorkspace` path traversal protection shared by all file tools

#### Phase 3 — Multi-agent orchestration
- `Agent` interface + `SharedMemory` with state, outputs, and message mailboxes
- `AgentOrchestrator` with DAG execution, retry, and conditional branching (`retryFrom`)
- `PlannerAgent` (LLM-based structured plan generation)
- `CodeAgent` (LLM-based diff generation from plan + context)
- `ReviewerAgent` (LLM-based approval/rejection with issue list)
- `ValidatorAgent` (runs lint/typecheck/tests via ToolRegistry)
- `ContextAgent` (reads plan-targeted files into ContextChunks)
- `FileAgent` (parses uploaded files into ContextChunks)

#### Phase 4 — Multi-provider
- `OpenAIProvider` with streaming tool call accumulation
- `OpenAICompatibleProvider` generic SSE client (base for vLLM, llama.cpp)
- `GeminiProvider` with function calling + images
- `LlamaCppProvider` and `VLLMProvider` thin wrappers
- `ModelRouter` routing completion/chat/embedding tasks to different providers

#### Phase 5 — Inline autocomplete
- `AidevInlineCompletionProvider` with microtask coalescing and FIM prompting

#### Phase 6 — Codebase indexing
- `ChunkingService` regex-based TS/JS function+class extraction with sliding window fallback
- `VectorStore` in-memory with L2 distance KNN search

#### Phase 7 — Composer + File upload
- `ComposerController` Plan→Diff→Apply with per-file approval and git integration
- `FileUploadService` file type detection, chunking, session memory

#### Phase 8 — Checkpoints + Auto-fix + @-symbols
- `CheckpointManager` shadow-copy snapshot/restore
- `AutoFixService` LSP diagnostics fix loop with 3-iteration cap
- `ContextResolver` @-symbol parsing and resolution with autocomplete suggestions

#### Phase 9 — MCP + Rules
- `MCPClientManager` lifecycle management for Model Context Protocol servers
- `RulesEngine` project/user/team rules with glob-based auto-attach

#### Phase 10 — VS Code integration
- Webview message protocol with discriminated unions and type guards
- `ProviderFactory` reading VS Code config + SecretStorage
- `ChatViewProvider` WebviewViewProvider with streaming delta forwarding
- Vanilla JS chat UI with mode switcher, streaming cursor, tool cards
- Full `extension.ts` activation: providers, tools, agent, chat view, inline completion, commands, config watcher

### Development infrastructure
- vitest unit + integration test setup with VS Code API mock
- husky pre-commit hook (lint-staged + typecheck)
- husky post-commit hook generating per-commit JSON test reports
- esbuild extension bundle (596 KB production)
- 306 tests across 44 test files, 100% passing, 0 TypeScript errors

### Documentation
- `README.md` — marketplace listing and quickstart
- `GROUND_RULES.md` — TDD policy and test automation
- `docs/ARCHITECTURE.md` — 795 lines, full system design
- `docs/SYSTEM_PROMPTS.md` — 640 lines, every prompt
- `docs/API_REFERENCE.md` — 1741 lines, all TypeScript interfaces
- `docs/IMPLEMENTATION_ROADMAP.md` — 730 lines, 10-phase plan
- `docs/SETUP_GUIDE.md` — 675 lines, developer setup
- `docs/USER_GUIDE.md` — end-user usage walkthrough
- `docs/PUBLISHING.md` — step-by-step marketplace publishing
