# Champ Implementation Roadmap

This document defines the 10-phase implementation plan for the Champ VS Code extension. Each phase builds on the prior one, following strict TDD discipline as defined in `GROUND_RULES.md`.

---

## Table of Contents

1. [Development Principles](#development-principles)
2. [Phase Overview](#phase-overview)
3. [Phase 1: Foundation and Provider Layer](#phase-1-foundation-and-provider-layer)
4. [Phase 2: Tool System](#phase-2-tool-system)
5. [Phase 3: Chat UI and Webview](#phase-3-chat-ui-and-webview)
6. [Phase 4: Codebase Indexing and RAG](#phase-4-codebase-indexing-and-rag)
7. [Phase 5: Multi-Agent Orchestration](#phase-5-multi-agent-orchestration)
8. [Phase 6: Composer and Diff Engine](#phase-6-composer-and-diff-engine)
9. [Phase 7: Inline Autocomplete](#phase-7-inline-autocomplete)
10. [Phase 8: File Upload and Ingestion](#phase-8-file-upload-and-ingestion)
11. [Phase 9: Safety, Checkpoints, and Rules](#phase-9-safety-checkpoints-and-rules)
12. [Phase 10: Observability, MCP, and Polish](#phase-10-observability-mcp-and-polish)

---

## Development Principles

### TDD Workflow (Non-Negotiable)

Every feature follows the Red-Green-Refactor cycle:

1. **Red**: Write a failing test that defines the expected behavior
2. **Green**: Write the minimum code to make the test pass
3. **Refactor**: Clean up the code while keeping all tests green

No production code is merged without tests that were written first. See `GROUND_RULES.md` for complete TDD requirements.

### OSS Libraries to Leverage

The following open-source projects provide patterns and, where license-compatible, reusable code:

| Project | What to Leverage | License |
|---|---|---|
| [Continue.dev](https://github.com/continuedev/continue) | Chat UI patterns, context gathering, provider abstraction | Apache-2.0 |
| [Cline](https://github.com/cline/cline) | Agent workflow patterns, tool execution, approval UX | Apache-2.0 |
| [Aider](https://github.com/paul-gauthier/aider) | Diff generation and application engine, edit formats | Apache-2.0 |
| [Codeium](https://codeium.com/) | Autocomplete UX patterns, ghost text rendering, debounce strategies | Proprietary (patterns only) |
| [tree-sitter](https://tree-sitter.github.io/) | Code parsing and chunking for indexing | MIT |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Vector similarity search in SQLite | MIT/Apache-2.0 |
| [tiktoken](https://github.com/openai/tiktoken) | Token counting | MIT |

---

## Phase Overview

```
Phase 1: Foundation     [Weeks 1-2]  Providers, config, token counting
Phase 2: Tools          [Weeks 3-4]  Tool registry, built-in tools, approval
Phase 3: Chat UI        [Weeks 5-6]  Webview, message protocol, streaming
Phase 4: Indexing       [Weeks 7-8]  Tree-sitter, embeddings, vector store
Phase 5: Agents         [Weeks 9-11] Multi-agent orchestrator, all 6 agents
Phase 6: Composer       [Weeks 12-13] Multi-file edits, diff engine
Phase 7: Autocomplete   [Week 14]    Inline completion provider
Phase 8: Upload         [Week 15]    File upload, parsing, chunking
Phase 9: Safety         [Weeks 16-17] Secrets, sandbox, checkpoints, rules
Phase 10: Polish        [Weeks 18-20] Observability, MCP, performance, docs
```

---

## Phase 1: Foundation and Provider Layer

### Goal

Establish the LLM provider abstraction layer, configuration system, and core utilities. Every subsequent phase depends on being able to send messages to an LLM and receive streamed responses.

### Deliverables

- `LLMProvider` interface and base implementation
- Provider implementations: Claude, OpenAI, Gemini, Ollama, llama.cpp, vLLM, OpenAI-compatible
- `ProviderRegistry` singleton
- `ModelRouter` for task-based model selection
- Token counting utility (tiktoken integration)
- VS Code configuration reading and validation

### Key Files to Create

```
src/providers/types.ts              - All provider-related TypeScript interfaces
src/providers/base-provider.ts      - Abstract base class with shared logic
src/providers/claude.ts             - Anthropic Messages API implementation
src/providers/openai.ts             - OpenAI Chat Completions implementation
src/providers/gemini.ts             - Google Generative AI implementation
src/providers/ollama.ts             - Ollama REST API implementation
src/providers/llamacpp.ts           - llama.cpp OpenAI-compatible implementation
src/providers/vllm.ts               - vLLM OpenAI-compatible implementation
src/providers/openai-compatible.ts  - Generic OpenAI-compatible implementation
src/providers/registry.ts           - ProviderRegistry singleton
src/providers/model-router.ts       - ModelRouter with task-based routing
src/utils/token-counter.ts          - Token counting using tiktoken
src/utils/config.ts                 - VS Code configuration helpers

test/unit/providers/claude.test.ts
test/unit/providers/openai.test.ts
test/unit/providers/gemini.test.ts
test/unit/providers/ollama.test.ts
test/unit/providers/llamacpp.test.ts
test/unit/providers/vllm.test.ts
test/unit/providers/openai-compatible.test.ts
test/unit/providers/registry.test.ts
test/unit/providers/model-router.test.ts
test/unit/utils/token-counter.test.ts
test/integration/providers/ollama-live.test.ts
```

### Test Coverage Targets

- Unit: 95% line coverage for all provider files
- Integration: Live tests against Ollama (requires running instance, skipped in CI if unavailable)

### Risks

- **Ollama API changes**: Pin to a specific API version, test against it
- **Token counting accuracy**: tiktoken may not match all models exactly; document known discrepancies
- **Streaming edge cases**: Connection drops, partial JSON, backpressure

### Dependencies

- None (this is the foundation)

### OSS Patterns

- Continue.dev: Provider abstraction pattern, streaming implementation
- tiktoken: Direct dependency for token counting

---

## Phase 2: Tool System

### Goal

Build the tool registry, implement all built-in tools mapped to VS Code APIs, and establish the approval flow for dangerous operations.

### Deliverables

- `Tool` interface and `ToolRegistry`
- Built-in tools: read_file, write_file, edit_file, search_files, list_files, run_terminal, read_diagnostics, get_open_tabs, ask_user, git_diff, git_commit, web_search
- Approval flow (yolo mode bypass)
- Tool definition export for LLM consumption
- Prompt-based tool calling parser (XML format)

### Key Files to Create

```
src/tools/types.ts                  - Tool-related TypeScript interfaces
src/tools/registry.ts               - ToolRegistry implementation
src/tools/read-file.ts              - Read file contents
src/tools/write-file.ts             - Write/create files
src/tools/edit-file.ts              - Search-and-replace edits
src/tools/search-files.ts           - Regex search via ripgrep
src/tools/list-files.ts             - Glob-based file listing
src/tools/run-terminal.ts           - Terminal command execution
src/tools/read-diagnostics.ts       - VS Code diagnostics
src/tools/get-open-tabs.ts          - Open editor tabs
src/tools/ask-user.ts               - User prompt tool
src/tools/git-diff.ts               - Git diff tool
src/tools/git-commit.ts             - Git commit tool
src/tools/web-search.ts             - Web search tool
src/tools/approval-flow.ts          - Approval request/response handling
src/tools/xml-parser.ts             - Parse XML tool calls from LLM responses

test/unit/tools/registry.test.ts
test/unit/tools/read-file.test.ts
test/unit/tools/write-file.test.ts
test/unit/tools/edit-file.test.ts
test/unit/tools/search-files.test.ts
test/unit/tools/list-files.test.ts
test/unit/tools/run-terminal.test.ts
test/unit/tools/read-diagnostics.test.ts
test/unit/tools/get-open-tabs.test.ts
test/unit/tools/ask-user.test.ts
test/unit/tools/git-diff.test.ts
test/unit/tools/git-commit.test.ts
test/unit/tools/approval-flow.test.ts
test/unit/tools/xml-parser.test.ts
test/integration/tools/file-operations.test.ts
```

### Test Coverage Targets

- Unit: 95% line coverage
- Integration: File operation round-trips (create, read, edit, delete) on a temp workspace

### Risks

- **ripgrep availability**: Bundle `@vscode/ripgrep` or shell out to `rg`; test both paths
- **Terminal sandboxing**: Must prevent command injection; test with adversarial inputs
- **XML parsing fragility**: Local models may produce malformed XML; implement lenient parsing with fallback

### Dependencies

- Phase 1 (provider types for tool definitions)

### OSS Patterns

- Cline: Tool execution patterns, approval UX flow
- Aider: edit_file search/replace format

---

## Phase 3: Chat UI and Webview

### Goal

Build the React-based chat webview, the `ChatViewProvider` bridge, and the message protocol between extension host and webview.

### Deliverables

- `ChatViewProvider` implementing `WebviewViewProvider`
- Full message protocol (extension-to-webview and webview-to-extension)
- React chat UI: message list, input box, mode selector, streaming display
- Markdown rendering with syntax highlighting
- Tool call/result display components
- Status bar with model/token/latency info

### Key Files to Create

```
src/ui/chat-view-provider.ts        - WebviewViewProvider implementation
src/ui/message-protocol.ts          - Message type definitions
src/ui/state-manager.ts             - Chat state management

webview-ui/src/index.tsx             - React entry point
webview-ui/src/App.tsx               - Root component
webview-ui/src/components/ChatPanel.tsx
webview-ui/src/components/MessageList.tsx
webview-ui/src/components/MessageBubble.tsx
webview-ui/src/components/InputBox.tsx
webview-ui/src/components/ModeSelector.tsx
webview-ui/src/components/ToolCallDisplay.tsx
webview-ui/src/components/StatusBar.tsx
webview-ui/src/components/MarkdownRenderer.tsx
webview-ui/src/hooks/useVSCodeAPI.ts
webview-ui/src/hooks/useChat.ts
webview-ui/src/hooks/useStreaming.ts
webview-ui/src/styles/chat.css

test/unit/ui/chat-view-provider.test.ts
test/unit/ui/message-protocol.test.ts
test/unit/ui/state-manager.test.ts
test/e2e/chat-interaction.test.ts
```

### Test Coverage Targets

- Unit: 90% line coverage for extension-side code
- E2E: Basic chat flow (send message, receive streamed response, display)

### Risks

- **Webview lifecycle**: Webview can be disposed and recreated; state must survive
- **Streaming display**: Race conditions between fast deltas and React re-renders
- **VS Code theming**: CSS must work across light, dark, and high-contrast themes

### Dependencies

- Phase 1 (providers for actual LLM interaction)
- Phase 2 (tool display in chat)

### OSS Patterns

- Continue.dev: Chat UI layout, VS Code webview patterns
- Cline: Tool approval display, step-by-step execution log

---

## Phase 4: Codebase Indexing and RAG

### Goal

Build the indexing pipeline that parses workspace files into chunks, generates embeddings, and stores them in a local vector database for semantic search.

### Deliverables

- Tree-sitter-based code chunker
- `EmbeddingService` implementations (Ollama, OpenAI)
- `VectorStore` using sqlite-vec
- `IndexingService` with incremental indexing
- File watcher integration for automatic re-indexing
- Hybrid search (vector + lexical via ripgrep)
- Token-budget-aware context packing

### Key Files to Create

```
src/indexing/types.ts                - Indexing-related interfaces
src/indexing/chunker.ts              - Tree-sitter code chunker
src/indexing/embedding-service.ts    - Embedding generation service
src/indexing/vector-store.ts         - sqlite-vec wrapper
src/indexing/indexing-service.ts     - Main indexing orchestrator
src/indexing/file-watcher.ts         - Workspace file watcher
src/indexing/hybrid-search.ts        - Combined vector + lexical search
src/indexing/context-packer.ts       - Token-budget-aware context assembly

test/unit/indexing/chunker.test.ts
test/unit/indexing/embedding-service.test.ts
test/unit/indexing/vector-store.test.ts
test/unit/indexing/indexing-service.test.ts
test/unit/indexing/hybrid-search.test.ts
test/unit/indexing/context-packer.test.ts
test/integration/indexing/full-pipeline.test.ts
```

### Test Coverage Targets

- Unit: 90% line coverage
- Integration: Index a sample project, query, verify results

### Risks

- **Tree-sitter WASM**: Loading tree-sitter grammars in VS Code extension host requires WASM; test Node.js native and WASM paths
- **sqlite-vec native module**: Must compile for the target platform; consider bundling prebuilt binaries
- **Embedding latency**: Local embedding models can be slow; batch and parallelize
- **Large workspaces**: Must handle 10,000+ files without blocking the extension host

### Dependencies

- Phase 1 (embedding models use LLM providers)

### OSS Patterns

- tree-sitter: Direct dependency for parsing
- sqlite-vec: Direct dependency for vector storage
- Continue.dev: Indexing and context retrieval patterns

---

## Phase 5: Multi-Agent Orchestration

### Goal

Build the multi-agent system: the `AgentOrchestrator`, all six agent implementations, shared memory, DAG execution, message passing, and retry logic.

### Deliverables

- `AgentOrchestrator` with DAG execution engine
- `SharedMemory` implementation
- Agent implementations: Planner, Code, Reviewer, Validator, Context, File
- Workflow definitions for Agent mode and Composer mode
- Message passing between agents
- Retry logic with feedback loops
- Progress events for the UI

### Key Files to Create

```
src/agent/types.ts                   - Agent-related interfaces
src/agent/orchestrator.ts            - AgentOrchestrator implementation
src/agent/shared-memory.ts           - SharedMemory implementation
src/agent/workflow-definitions.ts    - DAG definitions for each mode
src/agent/agents/planner.ts          - Planner Agent
src/agent/agents/code.ts             - Code Agent
src/agent/agents/reviewer.ts         - Reviewer Agent
src/agent/agents/validator.ts        - Validator Agent
src/agent/agents/context.ts          - Context Agent
src/agent/agents/file.ts             - File Agent

test/unit/agent/orchestrator.test.ts
test/unit/agent/shared-memory.test.ts
test/unit/agent/agents/planner.test.ts
test/unit/agent/agents/code.test.ts
test/unit/agent/agents/reviewer.test.ts
test/unit/agent/agents/validator.test.ts
test/unit/agent/agents/context.test.ts
test/unit/agent/agents/file.test.ts
test/integration/agent/full-workflow.test.ts
test/integration/agent/retry-logic.test.ts
```

### Test Coverage Targets

- Unit: 90% line coverage per agent, 95% for orchestrator
- Integration: Full workflow execution with mocked LLM responses

### Risks

- **DAG cycle detection**: Must validate workflow definitions for cycles at registration time
- **Retry explosion**: Without proper limits, retry loops can consume all tokens/time
- **Shared memory race conditions**: If future parallelism is added, SharedMemory must be thread-safe
- **Agent prompt quality**: Agent behavior depends heavily on prompt engineering; iterate on prompts with real models

### Dependencies

- Phase 1 (LLM providers)
- Phase 2 (tools for Code and Validator agents)
- Phase 4 (indexing for Context agent)

### OSS Patterns

- Cline: Agent execution loop, tool call handling within agent steps

---

## Phase 6: Composer and Diff Engine

### Goal

Build the composer mode for multi-file edits with plan-diff-apply workflow, the diff generation engine, and the diff viewer UI component.

### Deliverables

- `ComposerService` orchestrating plan-diff-apply
- Diff generation from Code Agent outputs
- Diff parsing and application engine
- Per-file and per-hunk approval
- `DiffViewer` React component with syntax highlighting
- Git integration (auto-branch, commit after apply)

### Key Files to Create

```
src/composer/types.ts                - Composer-related interfaces
src/composer/composer-service.ts     - ComposerService implementation
src/composer/diff-engine.ts          - Diff generation, parsing, application
src/composer/git-integration.ts      - Auto-branch, commit, rollback

webview-ui/src/components/DiffViewer.tsx
webview-ui/src/components/HunkApproval.tsx
webview-ui/src/components/FileDiffHeader.tsx

test/unit/composer/composer-service.test.ts
test/unit/composer/diff-engine.test.ts
test/unit/composer/git-integration.test.ts
test/integration/composer/multi-file-edit.test.ts
```

### Test Coverage Targets

- Unit: 95% line coverage for diff engine (correctness is critical)
- Integration: Apply diffs to real files, verify results

### Risks

- **Diff application correctness**: Off-by-one errors in line numbers can corrupt files; extensive test fixtures required
- **Conflict detection**: If files have changed since the diff was generated, application must detect and report conflicts
- **Large diffs**: Performance of diff viewer with 1000+ lines; virtualize rendering

### Dependencies

- Phase 3 (webview for DiffViewer)
- Phase 5 (agents for plan and code generation)

### OSS Patterns

- Aider: Diff generation format, search/replace edit blocks, diff application logic

---

## Phase 7: Inline Autocomplete

### Goal

Implement the inline completion provider that shows ghost text suggestions as the user types, using a small local model for low latency.

### Deliverables

- `InlineCompletionItemProvider` implementation
- Context gathering (prefix, suffix, imports, open tabs)
- Debounce logic
- Model router integration (routes to small autocomplete model)
- Ghost text rendering

### Key Files to Create

```
src/completion/types.ts              - Completion-related interfaces
src/completion/inline-provider.ts    - InlineCompletionItemProvider
src/completion/context-gatherer.ts   - Gather completion context
src/completion/debouncer.ts          - Debounce utility

test/unit/completion/inline-provider.test.ts
test/unit/completion/context-gatherer.test.ts
test/unit/completion/debouncer.test.ts
test/integration/completion/autocomplete-flow.test.ts
```

### Test Coverage Targets

- Unit: 90% line coverage
- Integration: Simulated typing with mocked provider response

### Risks

- **Latency**: Must be under 200ms total (debounce + inference). If the local model is too slow, suggestions feel laggy
- **Context window management**: Autocomplete models have small context windows (2K-4K tokens); must fit prefix+suffix
- **Cancellation**: Rapid typing must cancel in-flight requests; test with high-frequency trigger events

### Dependencies

- Phase 1 (LLM providers, model router)

### OSS Patterns

- Codeium: Ghost text UX, debounce strategy, context prioritization

---

## Phase 8: File Upload and Ingestion

### Goal

Allow users to upload files into the chat via drag-and-drop, file picker, or clipboard paste. Parse and chunk uploaded files for use in conversation context.

### Deliverables

- `FileUploadService` processing pipeline
- File parsers for code, text, JSON, YAML, Markdown, log files, PDF
- Token-aware chunking
- `FileUploadZone` React component (drag-drop, clipboard)
- Session memory integration
- Optional vector indexing of uploaded files

### Key Files to Create

```
src/upload/types.ts                  - Upload-related interfaces
src/upload/upload-service.ts         - FileUploadService implementation
src/upload/parsers/code-parser.ts    - Code file parser
src/upload/parsers/text-parser.ts    - Plain text parser
src/upload/parsers/json-parser.ts    - JSON parser
src/upload/parsers/yaml-parser.ts    - YAML parser
src/upload/parsers/markdown-parser.ts - Markdown parser
src/upload/parsers/log-parser.ts     - Log file parser (error/warning extraction)
src/upload/parsers/pdf-parser.ts     - PDF to text parser
src/upload/chunker.ts                - Token-aware file chunker
src/upload/session-memory.ts         - SessionMemory implementation

webview-ui/src/components/FileUploadZone.tsx
webview-ui/src/components/UploadedFileList.tsx
webview-ui/src/hooks/useFileUpload.ts

test/unit/upload/upload-service.test.ts
test/unit/upload/parsers/code-parser.test.ts
test/unit/upload/parsers/json-parser.test.ts
test/unit/upload/parsers/log-parser.test.ts
test/unit/upload/chunker.test.ts
test/unit/upload/session-memory.test.ts
```

### Test Coverage Targets

- Unit: 90% line coverage
- Integration: Upload a file, verify chunking, verify context injection

### Risks

- **PDF parsing**: Reliable PDF-to-text in Node.js is hard; consider `pdf-parse` or `pdfjs-dist`. May not work for scanned PDFs
- **Large files**: Files over 1MB need careful chunking to avoid memory spikes
- **Binary detection**: Must correctly identify and reject binary files (images, executables)

### Dependencies

- Phase 3 (webview for upload UI)
- Phase 4 (optional indexing of uploaded files)

---

## Phase 9: Safety, Checkpoints, and Rules

### Goal

Implement the safety layer (secret redaction, command sandbox, confidence scoring), the checkpoint system for rollback, and the rules engine for project-level configuration.

### Deliverables

- `SecretRedactor` with regex pattern library
- `CommandSandbox` with blocklist/allowlist
- `ConfidenceScorer` for LLM output evaluation
- `CheckpointManager` with shadow-copy snapshots
- `RulesEngine` loading from settings, project files, directory files
- Integration of safety layer into the tool execution pipeline

### Key Files to Create

```
src/safety/types.ts                  - Safety-related interfaces
src/safety/secret-redactor.ts        - Secret detection and redaction
src/safety/command-sandbox.ts        - Command validation and sandbox
src/safety/confidence-scorer.ts      - Confidence scoring

src/checkpoints/types.ts             - Checkpoint interfaces
src/checkpoints/checkpoint-manager.ts - CheckpointManager implementation

src/rules/types.ts                   - Rules-related interfaces
src/rules/rules-engine.ts           - RulesEngine implementation
src/rules/rules-loader.ts           - File-based rules loading

test/unit/safety/secret-redactor.test.ts
test/unit/safety/command-sandbox.test.ts
test/unit/safety/confidence-scorer.test.ts
test/unit/checkpoints/checkpoint-manager.test.ts
test/unit/rules/rules-engine.test.ts
test/unit/rules/rules-loader.test.ts
test/integration/safety/redaction-pipeline.test.ts
test/integration/checkpoints/snapshot-restore.test.ts
```

### Test Coverage Targets

- Unit: 95% line coverage for safety module (security-critical)
- Integration: End-to-end redaction, checkpoint create/restore cycles

### Risks

- **Secret pattern false positives**: Overly aggressive patterns may redact code that looks like keys but is not; test with real codebases
- **Checkpoint disk usage**: Large workspaces with many checkpoints can consume significant disk; implement pruning
- **Rules conflicts**: Overlapping rules from different sources need clear precedence; document and test conflict resolution

### Dependencies

- Phase 2 (tool execution pipeline for safety integration)
- Phase 3 (webview for checkpoint restore UI)

---

## Phase 10: Observability, MCP, and Polish

### Goal

Add metrics collection, MCP protocol support for external tool servers, performance optimization, and final polish for a release-quality extension.

### Deliverables

- `MetricsCollector` with all tracked metrics
- Metrics display in status bar and output channel
- MCP client for connecting to external tool servers
- MCP tool registration in ToolRegistry
- Performance profiling and optimization
- Error handling audit across all modules
- Extension packaging and publishing preparation

### Key Files to Create

```
src/observability/types.ts           - Observability interfaces
src/observability/metrics-collector.ts - MetricsCollector implementation
src/observability/output-logger.ts   - Structured OutputChannel logging

src/mcp/types.ts                     - MCP-related interfaces
src/mcp/mcp-client.ts               - MCP client implementation
src/mcp/mcp-tool-adapter.ts         - Adapter from MCP tools to Tool interface

src/prompts/builder.ts              - System prompt assembly
src/prompts/templates.ts            - All prompt templates

test/unit/observability/metrics-collector.test.ts
test/unit/observability/output-logger.test.ts
test/unit/mcp/mcp-client.test.ts
test/unit/mcp/mcp-tool-adapter.test.ts
test/unit/prompts/builder.test.ts
test/integration/mcp/mcp-connection.test.ts
test/e2e/full-agent-workflow.test.ts
test/e2e/composer-workflow.test.ts
```

### Test Coverage Targets

- Unit: 90% line coverage
- E2E: Full workflows in a real VS Code instance
- Overall project: 85%+ line coverage

### Risks

- **MCP protocol evolution**: The MCP spec is still evolving; pin to a specific version and document
- **Performance regression**: Adding observability overhead; benchmark before/after
- **Extension size**: Bundled native modules (sqlite-vec, tree-sitter WASM) increase extension size; monitor and optimize

### Dependencies

- All prior phases (this is the integration and polish phase)

### OSS Patterns

- Continue.dev: MCP integration patterns
- Cline: Extension packaging, marketplace preparation

---

## Cross-Phase Dependency Graph

```
Phase 1: Foundation
    |
    +---> Phase 2: Tools
    |         |
    |         +---> Phase 5: Agents ------+
    |         |         |                  |
    |         +---> Phase 9: Safety       |
    |                                      |
    +---> Phase 4: Indexing               |
    |         |                            |
    |         +---> Phase 5: Agents       |
    |                                      |
    +---> Phase 7: Autocomplete           |
    |                                      |
    +---> Phase 3: Chat UI               |
              |                            |
              +---> Phase 6: Composer <----+
              |
              +---> Phase 8: Upload
              |
              +---> Phase 9: Safety (UI)
              |
              +---> Phase 10: Polish (all phases)
```

---

## Milestone Checkpoints

| Milestone | After Phase | Criteria |
|---|---|---|
| **M1: Can talk to LLMs** | Phase 1 | All 7 providers pass streaming tests |
| **M2: Can use tools** | Phase 2 | Tools execute against VS Code APIs, approval flow works |
| **M3: Chat works end-to-end** | Phase 3 | User can send messages, see streamed responses in webview |
| **M4: Codebase is searchable** | Phase 4 | Semantic + lexical search returns relevant results |
| **M5: Agent mode works** | Phase 5 | Multi-agent workflow completes a real task (e.g., add a function + tests) |
| **M6: Composer works** | Phase 6 | Multi-file edit with diff viewer, per-hunk approval |
| **M7: Autocomplete works** | Phase 7 | Ghost text appears while typing, Tab accepts |
| **M8: Upload works** | Phase 8 | Drag-drop a file, see it used in conversation |
| **M9: Safe and recoverable** | Phase 9 | Secrets redacted, commands sandboxed, checkpoints restore cleanly |
| **M10: Release candidate** | Phase 10 | All features work, metrics visible, MCP connected, tests green |
