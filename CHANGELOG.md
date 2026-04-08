# Changelog

All notable changes to AIDev will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] — 2026-04-08

The "Skills" release. Adds reusable named prompt templates triggered
with `/<name>` from the chat input. Modeled after Claude Skills and
Continue.dev slash commands. Implements Phases A, B, and C of the
plan in `docs/PLAN_SKILLS.md`. Phase D (slash autocomplete dropdown)
is deferred to a follow-up.

### Added — Skills system

- **`src/skills/types.ts`** — `Skill`, `SkillFrontmatter`, `SkillSource`
  type definitions.
- **`src/skills/skill-loader.ts`** — parses markdown files with YAML
  frontmatter into `Skill` objects. Strict schema validation. Throws
  on missing `name`, missing `description`, invalid `mode`, or wrong
  `allowedTools` shape.
- **`src/skills/skill-registry.ts`** — central store. `register`,
  `unregister`, `get`, `list`, `matchPrefix`, `clear`. Source
  precedence (workspace > user > built-in) is enforced at registration
  time so the user can always override a built-in by dropping a
  same-named file in `.aidev/skills/`.
- **`src/skills/variable-resolver.ts`** — substitutes `{{variable}}`
  placeholders in skill templates. Supports `{{selection}}`,
  `{{currentFile}}`, `{{language}}`, `{{userInput}}`, `{{cursorLine}}`,
  `{{date}}`, `{{branch}}`, `{{workspaceRoot}}`. Unknown placeholders
  are left intact so users notice typos rather than getting silent
  empty output.
- **`src/skills/built-in.ts`** — 8 built-in skills shipped inline:
  - `/explain` — explains the current selection (Ask mode)
  - `/test` — generates unit tests for the current file
  - `/refactor` — refactors with a user-supplied goal
  - `/review` — code review with severity-tagged checklist (Ask mode)
  - `/commit` — generates Conventional Commits message from staged diff
  - `/doc` — adds JSDoc/docstrings to the selection
  - `/fix` — fixes the diagnostic at the current cursor line
  - `/optimize` — performance review of the selection (Ask mode)
- **ChatViewProvider integration**:
  - `setSkillRegistry()` attaches a registry
  - `setSkillContext()` attaches the editor-context provider + variable
    resolver
  - `expandSkill()` intercepts `/<name>` user messages, looks them up,
    resolves variables, and replaces the literal `/<name> ...` text
    with the resolved skill template before passing to the agent
- **Extension activation**:
  - Built-in skills loaded at activation
  - Workspace skills loaded from `<workspace>/.aidev/skills/*.md`
  - User skills loaded from `~/.aidev/skills/*.md`
  - FileSystemWatcher on the workspace skills directory triggers a
    reload on create/change/delete
  - `buildSkillContext()` populates `selection`, `currentFile`,
    `language`, `cursorLine` from the active editor

### Tests

- 436 tests passing (up from 364, **+72 new**):
  - 11 SkillLoader tests
  - 12 SkillRegistry tests (incl. source precedence)
  - 9 VariableResolver tests
  - 33 built-in skill spot checks (8 skills × 4 invariants + 1 inventory)
  - 4 ChatViewProvider skill-invocation tests
  - +3 ChatViewProvider helper-shape changes
- Test count grows by 19.8% with no regressions in the existing 364 tests.

### Notes

- API keys still go through `AIDev: Set API Key` (SecretStorage). Skills
  never need keys because they're prompt templates, not provider config.
- User-defined skills can override any built-in by dropping a same-named
  `.md` file in `.aidev/skills/` (workspace) or `~/.aidev/skills/` (user).
- Phase D — slash-command autocomplete dropdown in the chat input — is
  deferred to v0.1.6 to keep this release focused.

## [0.1.4] — 2026-04-06

The "YAML config" release. Adds a hierarchical, version-controlled
config file format that replaces the flat `aidev.*` keys in
`settings.json`. Backward compatible — existing settings.json users
keep working unchanged.

### Added

- **`.aidev/config.yaml` workspace config and `~/.aidev/config.yaml`
  user config.** Both YAML files use the same schema (see
  `docs/CONFIG.md`). The workspace file is committed and shared with
  the team; the user file is personal. Workspace deep-merges over
  user, then over legacy `aidev.*` settings, then over built-in
  defaults.
- **`ConfigLoader` module** (`src/config/config-loader.ts`) — pure
  parser/validator/merger with no filesystem I/O. Hand-rolled
  schema validation with clear error messages. Rejects any attempt
  to put `apiKey` in YAML (secrets stay in SecretStorage).
- **Environment variable substitution** — `${env:VAR_NAME}`
  placeholders in any config string are resolved against
  `process.env`. Unset variables are left as the literal placeholder
  so misconfigurations are visible.
- **`AIDev: Generate Config File` command** — writes a starter
  `.aidev/config.yaml` to the workspace root with every option
  documented and conservative defaults.
- **Hot reload on YAML save.** A FileSystemWatcher on
  `.aidev/config.yaml` triggers `loadProvider()` whenever the file
  is created, modified, or deleted.
- **`docs/CONFIG.md`** — full schema reference, migration guide
  from `settings.json`, secret handling rules, validation error
  table, workspace vs user split guidance.
- **`ProviderFactory.createFromAidevConfig()`** — new YAML-driven
  factory path alongside the existing `createFromConfig()`.
- **`js-yaml` dependency** (~14kb).

### Tests

- 364 tests passing (up from 340). 24 new tests:
  - 19 ConfigLoader tests covering parse, validate, merge,
    substituteEnv, withDefaults, activeProviderConfig, and the
    apiKey rejection rule
  - 5 createFromAidevConfig tests covering each provider, default
    fallthrough, and the no-provider-set case

### Documentation

- New `docs/CONFIG.md` (full schema reference)

## [0.1.3] — 2026-04-06

The "anti-hallucination + close the gap" release. Adds documentation
about what's currently shipped vs aspirational, and closes the highest-
priority integration gaps from `docs/GAP_ANALYSIS.md` plus the
P0 hallucination mitigations from `docs/HALLUCINATION_MITIGATION.md`.

### Documentation

- **`docs/GAP_ANALYSIS.md`** — honest assessment of which Cursor-parity
  features are wired vs built-but-unwired vs missing. 22-item table
  with priority order for closure.
- **`docs/MODEL_GUIDE.md`** — practical guide to picking open models
  for AIDev's local agent workflow. Tier 1 / Tier 2 / Tier 0 (autocomplete)
  recommendations with Apple Silicon hardware notes.
- **`docs/HALLUCINATION_MITIGATION.md`** — deep analysis of why coding
  agents hallucinate and how Cursor, Aider, Continue.dev, Cline, and
  Codeium address it. Maps each pattern to AIDev's implementation
  priority.

### Added — anti-hallucination

- **Hardened system prompt** with explicit verify-before-claim and
  no-fabrication rules, plus few-shot examples showing wrong vs correct
  responses for the canonical "create a hello world file" task. Applies
  to both prompt-based and native tool-calling providers.
- **Repo map injection** (`src/indexing/repo-map-builder.ts`) — produces
  a compact tree-sitter-style outline of the workspace's top-level
  files and symbols (function/class names, no bodies) and prepends it
  to every chat session as a grounding preamble. Cached per session,
  re-fetched on `reset()`. Aider's most effective hallucination defense.
- **Verbose `edit_file` errors** — when `old_content` doesn't match,
  the tool returns the actual file content (numbered, capped at 80
  lines) so the model can self-correct on the next turn instead of
  retrying with the same wrong snippet.

### Added — gap closure

- **Mode enforcement.** `AgentController` now accepts a mode (`agent`,
  `ask`, `manual`, `plan`, `composer`) and:
  - Restricts the tool list per mode (`ask` and `plan` block all
    write/exec tools).
  - Appends mode-specific instructions to the system prompt.
  - Mode is set via `setMode()` and pushed through from both the
    chat view dropdown and the `AIDev: Toggle Mode` command.
- **`@-symbol` resolution in chat input.** `ChatViewProvider.setContextResolver()`
  attaches a `ContextResolver`. Every user message is scanned for
  `@Files(...)`, `@Folders(...)`, `@Codebase`, `@Web`, `@Git`, `@Docs(...)`,
  `@Code`, `@Symbols(...)` references and the resolved content is
  appended to the message before sending to the agent.
- **Real approval flow piped through the webview.** `ChatViewProvider`
  builds a `requestApproval` callback that posts an `approvalRequest`
  message to the webview and waits for the matching `approvalResponse`.
  The agent passes this callback to `processMessage`, which threads it
  into the tool execution context. Pending approvals are tracked by id
  in a Map so concurrent requests resolve independently.
- **Secret redaction.** `AgentController` calls `SecretScanner.scan()`
  on every tool output before storing it in conversation history. API
  keys, passwords, PEM blocks, and other secrets are replaced with
  `[REDACTED]` so they never reach the LLM on the next turn. The
  user-visible result preserves the original output for display.
- **Repo map auto-population** in `extension.ts`. The activation flow
  walks the workspace (top 200 TS/JS files, excluding `node_modules`,
  `dist`, `out`, `.git`, `test-reports`) and feeds them to
  `RepoMapBuilder` on demand. Errors are silently swallowed so a
  file-system permission issue doesn't break chat.
- **`ContextResolver` wired** in `extension.ts` and attached to the
  chat view at activation.

### Tests

- 340 tests passing (up from 313). 27 new tests covering:
  - 4 RepoMapBuilder tests (was 8 already, total 8)
  - 5 mode enforcement tests
  - 4 repo map grounding tests
  - 3 anti-hallucination directive tests
  - 3 @-symbol resolution tests
  - 3 approval flow tests
  - 2 secret redaction tests
  - 1 verbose edit_file error test
  - 2 RepoMapBuilder size cap and stability tests

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
