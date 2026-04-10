# Champ Architecture

This document is the single source of truth for the Champ VS Code extension architecture. It describes every module, data flow, agent system, provider abstraction, tool system, indexing pipeline, checkpoint mechanism, safety layer, and observability infrastructure.

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Module Decomposition](#module-decomposition)
3. [Data Flow Diagrams](#data-flow-diagrams)
4. [Multi-Agent System](#multi-agent-system)
5. [LLM Provider Abstraction](#llm-provider-abstraction)
6. [Tool System Design](#tool-system-design)
7. [Codebase Indexing](#codebase-indexing)
8. [Checkpoint System](#checkpoint-system)
9. [Safety Layer](#safety-layer)
10. [Observability](#observability)

---

## High-Level Architecture

```
+-----------------------------------------------------------------------+
|                        VS Code Extension Host                         |
|                                                                       |
|  +------------------+    +------------------+    +-----------------+  |
|  | Agent            |    | LLM Providers    |    | Tool Registry   |  |
|  | Orchestrator     |<-->| (Claude, OpenAI, |<-->| (read, write,   |  |
|  | (Planner, Code,  |    |  Gemini, Ollama, |    |  search, term,  |  |
|  |  Reviewer, etc.) |    |  llama.cpp, vLLM)|    |  git, lint ...) |  |
|  +--------+---------+    +--------+---------+    +--------+--------+  |
|           |                       |                       |           |
|  +--------v---------+    +-------v--------+    +---------v--------+  |
|  | Shared Memory     |    | Model Router   |    | Approval Flow    |  |
|  | (task state,      |    | (small->auto,  |    | (user confirm    |  |
|  |  agent outputs)   |    |  large->agents)|    |  or yolo mode)   |  |
|  +-------------------+    +----------------+    +------------------+  |
|                                                                       |
|  +------------------+    +------------------+    +-----------------+  |
|  | Completion       |    | Composer         |    | Prompts         |  |
|  | (inline ghost    |    | (multi-file      |    | (system, agent, |  |
|  |  text, debounce) |    |  plan-diff-apply)|    |  mode appends)  |  |
|  +------------------+    +------------------+    +-----------------+  |
|                                                                       |
|  +------------------+    +------------------+    +-----------------+  |
|  | Indexing          |    | Checkpoints      |    | Safety          |  |
|  | (tree-sitter,    |    | (shadow-copy     |    | (secret redact, |  |
|  |  embeddings,     |    |  snapshots,      |    |  sandbox, conf  |  |
|  |  sqlite-vec)     |    |  restore)        |    |  scoring)       |  |
|  +------------------+    +------------------+    +-----------------+  |
|                                                                       |
|  +------------------+    +------------------+    +-----------------+  |
|  | Upload           |    | MCP              |    | Observability   |  |
|  | (drag-drop,      |    | (external tool   |    | (latency, token |  |
|  |  parse, chunk)   |    |  servers via     |    |  usage, agent   |  |
|  |                  |    |  stdio/transport)|    |  steps, errors) |  |
|  +------------------+    +------------------+    +-----------------+  |
|                                                                       |
|  +------------------+    +------------------+                         |
|  | Rules Engine     |    | UI               |                         |
|  | (.champ rules,   |    | (ChatViewProvider|                         |
|  |  user rules,     |    |  webview bridge) |                         |
|  |  project rules)  |    |                  |                         |
|  +------------------+    +--------+---------+                         |
|                                   |                                   |
+-----------------------------------|-----------------------------------+
                                    | postMessage / acquireVsCodeApi()
                                    v
+-----------------------------------------------------------------------+
|                         Webview (React Chat UI)                       |
|                                                                       |
|  +------------------+    +------------------+    +-----------------+  |
|  | ChatPanel        |    | DiffViewer       |    | FileUploadZone  |  |
|  | (message list,   |    | (unified diff,   |    | (drag-drop,     |  |
|  |  streaming,      |    |  per-hunk        |    |  preview,       |  |
|  |  markdown)       |    |  approval)       |    |  clipboard)     |  |
|  +------------------+    +------------------+    +-----------------+  |
|                                                                       |
|  +------------------+    +------------------+    +-----------------+  |
|  | ModeSelector     |    | ToolApproval     |    | StatusBar       |  |
|  | (agent/ask/      |    | (per-action      |    | (model, tokens, |  |
|  |  manual/plan)    |    |  accept/reject)  |    |  latency)       |  |
|  +------------------+    +------------------+    +-----------------+  |
+-----------------------------------------------------------------------+
```

---

## Module Decomposition

The extension is organized into two main layers: the **Extension Host** (Node.js, TypeScript) and the **Webview** (React). Each module maps to a directory under `src/`.

### Extension Host Modules

| Module | Directory | Responsibility |
|---|---|---|
| **Agent Orchestrator** | `src/agent/` | Multi-agent DAG execution, shared memory, message passing, retry logic |
| **Agent Implementations** | `src/agent/agents/` | Individual agent logic: Planner, Code, Reviewer, Validator, Context, File |
| **LLM Providers** | `src/providers/` | Unified LLM interface, provider implementations, model router, provider registry |
| **Tools** | `src/tools/` | Tool definitions, registry, execution contexts, approval flow |
| **Completion** | `src/completion/` | Inline autocomplete via `InlineCompletionItemProvider`, debounce, context gathering |
| **Composer** | `src/composer/` | Multi-file edit orchestration: plan generation, diff creation, unified diff viewer, apply/reject |
| **Indexing** | `src/indexing/` | Tree-sitter chunking, embedding generation, sqlite-vec vector store, incremental indexing |
| **Upload** | `src/upload/` | File upload handling, parsing (code, logs, JSON, YAML, Markdown, PDF), chunking |
| **Checkpoints** | `src/checkpoints/` | Shadow-copy file snapshots, checkpoint creation, restoration, cleanup |
| **Rules** | `src/rules/` | Rules engine loading .champ rules files, user rules from settings, project-level rules |
| **MCP** | `src/mcp/` | Model Context Protocol client, external tool server management via stdio transport |
| **Observability** | `src/observability/` | Metrics collector, latency tracking, token counting, agent step logs, failure tracking |
| **Safety** | `src/safety/` | Secret redaction (regex patterns), command sandboxing, confidence scoring, blocklists |
| **Prompts** | `src/prompts/` | System prompt templates, mode appends, per-agent prompts, tool calling templates |
| **UI** | `src/ui/` | ChatViewProvider (WebviewViewProvider), message protocol, state management |
| **Utils** | `src/utils/` | Shared utilities: token counting (tiktoken), path helpers, async helpers |

### Webview (React Chat UI)

| Component | Directory | Responsibility |
|---|---|---|
| **Components** | `webview-ui/src/components/` | React components: ChatPanel, DiffViewer, FileUploadZone, ModeSelector, ToolApproval, StatusBar |
| **Hooks** | `webview-ui/src/hooks/` | Custom React hooks: useVSCodeAPI, useChat, useStreaming, useFileUpload |
| **Styles** | `webview-ui/src/styles/` | CSS/theme files using VS Code's CSS custom properties for native look |

### Entry Point

`src/extension.ts` is the activation entry point. It initializes:

1. `ProviderRegistry` -- registers all configured LLM providers
2. `ModelRouter` -- maps tasks (autocomplete, chat, agent) to providers/models
3. `ToolRegistry` -- registers all built-in tools + MCP tools
4. `ChatViewProvider` -- registers the webview view provider for the sidebar
5. `InlineCompletionProvider` -- registers the autocomplete provider
6. `IndexingService` -- kicks off background workspace indexing
7. `CheckpointManager` -- initializes the checkpoint store
8. `MetricsCollector` -- starts observability collection
9. `RulesEngine` -- loads rules from all sources
10. VS Code commands and keybindings

---

## Data Flow Diagrams

### Agent Mode

Agent mode is the autonomous execution mode where the multi-agent system handles the user's request end-to-end with tool calls and iterative refinement.

```
User Message
    |
    v
+-------------------+
| ChatViewProvider   |  (webview -> extension message)
+--------+----------+
         |
         v
+--------+----------+
| AgentOrchestrator  |  Constructs DAG, initializes SharedMemory
+--------+----------+
         |
         v
+--------+----------+
| 1. Planner Agent   |  Breaks request into steps, outputs structured plan
+--------+----------+
         |
         v
+--------+----------+
| 2. Context Agent   |  Retrieves relevant code via vector search + ripgrep
+--------+----------+     Populates SharedMemory.context
         |
         v
+--------+----------+
| 3. Code Agent      |  Generates code changes, produces diffs
+--------+----------+     Uses tools: read_file, write_file, search, terminal
         |
         v
+--------+----------+
| 4. Reviewer Agent  |  Reviews changes for correctness, style, safety
+--------+----------+     May send back to Code Agent (retry edge in DAG)
         |
         v
+--------+----------+
| 5. Validator Agent |  Runs lint, typecheck, tests
+--------+----------+     May reject and trigger re-plan
         |
         v
+--------+----------+
| Approval Flow      |  Present changes to user (unless yoloMode)
+--------+----------+
         |
    User Accept/Reject
         |
         v
+--------+----------+
| Apply Changes      |  Write files, create checkpoint, git commit
+-------------------+
```

### Ask Mode

Ask mode is a simpler conversational mode. No tools are called. The LLM answers questions using available context.

```
User Message
    |
    v
+-------------------+
| ChatViewProvider   |
+--------+----------+
         |
         v
+--------+----------+
| Context Gathering  |  Current file, selection, open tabs, indexed context
+--------+----------+
         |
         v
+--------+----------+
| LLM Provider       |  Single call with system prompt (ask mode append)
+--------+----------+     No tool_use, no agent orchestration
         |
         v
+--------+----------+
| Stream Response    |  Tokens streamed to webview as they arrive
+-------------------+
```

### Composer Mode

Composer mode enables multi-file editing with a plan-diff-apply workflow.

```
User describes desired changes
    |
    v
+-------------------+
| ChatViewProvider   |
+--------+----------+
         |
         v
+--------+----------+
| Planner Agent      |  Generates structured plan: files to change, approach
+--------+----------+
         |
         v
+--------+----------+
| Context Agent      |  Gathers all referenced files
+--------+----------+
         |
         v
+--------+----------+
| Code Agent         |  Generates diffs for each file in the plan
+--------+----------+
         |
         v
+--------+----------+
| DiffViewer         |  Unified diff display in webview
+--------+----------+     Per-file and per-hunk accept/reject controls
         |
    User reviews each diff
         |
         v
+--------+----------+
| Apply Accepted     |  Only accepted hunks are applied
+--------+----------+
         |
         v
+--------+----------+
| Validator Agent    |  Post-apply lint/typecheck/test
+--------+----------+
         |
         v
+--------+----------+
| Checkpoint         |  Snapshot created for rollback
+-------------------+
```

### Inline Autocomplete

```
User types in editor
    |
    v (debounce: champ.autocomplete.debounceMs, default 300ms)
+-------------------+
| InlineCompletion   |
| Provider           |  Gathers context: prefix, suffix, file language,
+--------+----------+     imports, open tabs
         |
         v
+--------+----------+
| ModelRouter        |  Routes to small model (e.g., qwen2.5-coder:1.5b)
+--------+----------+
         |
         v
+--------+----------+
| LLM Provider       |  FIM (fill-in-middle) or completion call
+--------+----------+     Low temperature, short max_tokens
         |
         v
+--------+----------+
| Ghost Text         |  InlineCompletionItem rendered as ghost text
+-------------------+     User accepts with Tab
```

---

## Multi-Agent System

### Agent Roster

The system has six specialized agents, each with a focused responsibility:

| Agent | Module | Role | Input | Output |
|---|---|---|---|---|
| **Planner** | `src/agent/agents/planner.ts` | Decomposes user requests into step-by-step plans | User message + context summary | Structured plan (ordered steps with descriptions) |
| **Code** | `src/agent/agents/code.ts` | Generates and modifies code | Plan steps + file contents | Diffs (unified format), new file contents |
| **Reviewer** | `src/agent/agents/reviewer.ts` | Reviews generated changes for quality | Diffs + original files | Approval, rejection, or revision requests |
| **Validator** | `src/agent/agents/validator.ts` | Runs automated checks on changes | File paths of changed files | Lint results, type errors, test results |
| **Context** | `src/agent/agents/context.ts` | Retrieves relevant code from the workspace | Query terms, file patterns | Ranked code chunks with file paths and scores |
| **File** | `src/agent/agents/file.ts` | Handles uploaded files | Uploaded file buffers | Parsed content, chunks, optional vector embeddings |

### AgentOrchestrator

The `AgentOrchestrator` (`src/agent/orchestrator.ts`) is the central controller. It manages:

**DAG Execution**: Workflows are defined as directed acyclic graphs where nodes are agents and edges represent data dependencies.

```
                    +----------+
                    | Planner  |
                    +----+-----+
                         |
                    +----v-----+
                    | Context  |
                    +----+-----+
                         |
                    +----v-----+
                    |   Code   |
                    +----+-----+
                        / \
                       /   \
              +-------v+   +v--------+
              |Reviewer|   |Validator|
              +-------++   ++--------+
                       \   /
                        \ /
                    +----v-----+
                    |  Merge   |  (orchestrator combines results)
                    +----+-----+
                         |
                    +----v-----+
                    | Approval |
                    +----------+
```

**Shared Memory**: A central `SharedMemory` object accessible by all agents in a workflow run. Contains:

- `taskDescription`: The original user request
- `plan`: The planner's structured output
- `contextChunks`: Retrieved code snippets from the Context Agent
- `diffs`: Generated diffs from the Code Agent
- `reviewResult`: Approval/rejection from the Reviewer
- `validationResult`: Lint/typecheck/test results from the Validator
- `metadata`: Arbitrary key-value store for inter-agent communication

**Message Passing**: Agents communicate through typed `AgentMessage` objects written to shared memory. Each message has a `fromAgent`, `toAgent`, `type` (data, error, retry-request), and `payload`.

**Retry Logic**: When the Reviewer or Validator rejects changes, the orchestrator can:

1. Re-invoke the Code Agent with the rejection feedback appended to context
2. Limit retries via `maxRetries` (default: 3) to prevent infinite loops
3. Escalate to the user if retries are exhausted

**Conditional Branching**: The DAG supports conditional edges. For example, if the Reviewer approves, proceed to Validator; if the Reviewer rejects, loop back to Code Agent.

### Workflow Lifecycle

1. **Initialize**: Create `SharedMemory`, parse DAG definition for the selected mode
2. **Execute**: Walk the DAG topologically, invoking each agent in dependency order
3. **Monitor**: Emit progress events for the UI (which agent is active, step count)
4. **Collect**: Gather final `WorkflowResult` with all agent outputs and metrics
5. **Cleanup**: Release shared memory, log metrics to `MetricsCollector`

---

## LLM Provider Abstraction

### Unified Interface

All LLM providers implement a single `LLMProvider` interface:

```
+------------------------------------------------------+
|                    LLMProvider                        |
|------------------------------------------------------|
| + chat(messages, options) -> AsyncIterable<StreamDelta> |
| + complete(prompt, options) -> AsyncIterable<StreamDelta> |
| + supportsToolUse() -> boolean                       |
| + supportsStreaming() -> boolean                      |
| + countTokens(text) -> number                        |
| + modelInfo() -> ModelInfo                           |
+------------------------------------------------------+
         ^          ^          ^          ^
         |          |          |          |
   +-----+--+ +----+---+ +---+----+ +---+-------+
   | Claude  | | OpenAI | | Gemini | | Ollama    |
   +----+----+ +--------+ +--------+ +---+-------+
        |                                 |
   Cloud API                         Local API
                                          |
                               +----------+----------+
                               | llama.cpp | vLLM    |
                               +-----------+---------+
                               | OpenAI-Compatible   |
                               +---------------------+
```

### Provider Implementations

| Provider | Module | API Format | Tool Use | Notes |
|---|---|---|---|---|
| **Claude** | `src/providers/claude.ts` | Anthropic Messages API | Native | Primary cloud provider |
| **OpenAI** | `src/providers/openai.ts` | OpenAI Chat Completions | Native | GPT-4o, o1, etc. |
| **Gemini** | `src/providers/gemini.ts` | Google Generative AI | Native | Gemini 2.0 Flash, Pro |
| **Ollama** | `src/providers/ollama.ts` | Ollama REST API | Via prompt template | Local, manages model lifecycle |
| **llama.cpp** | `src/providers/llamacpp.ts` | OpenAI-compatible `/v1/chat/completions` | Via prompt template | Direct GGUF model serving |
| **vLLM** | `src/providers/vllm.ts` | OpenAI-compatible | Via prompt template | High-throughput serving |
| **OpenAI-Compatible** | `src/providers/openai-compatible.ts` | OpenAI Chat Completions | Depends on server | Generic adapter for any OpenAI-compatible endpoint |

### Model Router

The `ModelRouter` (`src/providers/model-router.ts`) maps task types to provider/model pairs:

| Task | Default Model | Rationale |
|---|---|---|
| **Autocomplete** | `qwen2.5-coder:1.5b` (Ollama) | Fast, small, low latency (~100ms) |
| **Chat / Ask** | Configured main model | Conversational quality |
| **Agent orchestration** | Configured main model (large) | Complex reasoning, tool use |
| **Embeddings** | `nomic-embed-text` (Ollama) or OpenAI `text-embedding-3-small` | Vector representations for RAG |

The router reads from VS Code settings (`champ.provider`, `champ.autocomplete.model`, `champ.indexing.embeddingProvider`) and constructs the appropriate provider instance.

### ProviderRegistry

The `ProviderRegistry` (`src/providers/registry.ts`) is a singleton that:

1. Holds all registered `LLMProvider` instances keyed by provider name
2. Handles provider initialization and configuration validation
3. Provides `getProvider(name)` and `getActiveProvider()` accessors
4. Listens for VS Code configuration changes and reinitializes providers

### Prompt-Based Tool Calling

For models that lack native `tool_use` support (most local models), the system uses a prompt-based fallback. The LLM receives tool definitions in XML format within the system prompt and returns tool calls as XML in its response. The provider parses these XML tool calls and routes them through the same `ToolRegistry` as native tool calls. See `docs/SYSTEM_PROMPTS.md` for the exact template.

---

## Tool System Design

### Registry Pattern

The `ToolRegistry` (`src/tools/registry.ts`) follows a plugin-based registry pattern:

```
+------------------+       +------------------+
| ToolRegistry     |       | Tool             |
|------------------|       |------------------|
| - tools: Map     |  1:N  | + name           |
| + register(tool) +-------+ + description     |
| + get(name)      |       | + parameters     |
| + list()         |       | + requiresApproval |
| + execute(name,  |       | + execute(ctx)   |
|     args, ctx)   |       +------------------+
+------------------+
```

### Built-in Tools

| Tool Name | VS Code API / Method | Requires Approval | Description |
|---|---|---|---|
| `read_file` | `workspace.fs.readFile` | No | Read file contents by path |
| `write_file` | `workspace.fs.writeFile` | Yes (unless yolo) | Write or create a file |
| `edit_file` | `WorkspaceEdit` + `workspace.applyEdit` | Yes (unless yolo) | Apply targeted edits to a file (search/replace) |
| `search_files` | ripgrep via child_process | No | Search workspace using regex patterns |
| `list_files` | `workspace.findFiles` | No | List files matching a glob pattern |
| `run_terminal` | `Terminal.sendText` or child_process | Yes (unless yolo) | Execute a shell command |
| `read_diagnostics` | `languages.getDiagnostics` | No | Get lint/type errors for a file |
| `get_open_tabs` | `window.visibleTextEditors` | No | List currently open editor tabs |
| `web_search` | HTTP fetch to search API | No | Search the web (when configured) |
| `ask_user` | Webview message | No | Prompt the user for clarification |
| `git_diff` | `git diff` via child_process | No | Get current git diff |
| `git_commit` | `git commit` via child_process | Yes (unless yolo) | Create a git commit |

### Approval Flow

```
Agent requests tool call
    |
    v
+-------------------+
| ToolRegistry      |
| .execute()        |
+--------+----------+
         |
         v
    tool.requiresApproval?
         |
    +----+----+
    |         |
   Yes        No
    |         |
    v         v
+-------+  +----------+
| yolo  |  | Execute   |
| mode? |  | directly  |
+--+----+  +----------+
   |
  +--+--+
  |     |
 Yes    No
  |     |
  v     v
Exec  +----------+
      | Send to  |
      | webview  |
      | for user |
      | approval |
      +----+-----+
           |
      Accept / Reject
           |
      +----+----+
      |         |
   Accept    Reject
      |         |
      v         v
   Execute   Return
              rejection
              to agent
```

### Tool Execution Context

Every tool call receives a `ToolExecutionContext` containing:

- `workspaceRoot`: Absolute path to workspace
- `activeFile`: Currently focused file (if any)
- `cancellationToken`: For aborting long-running tools
- `outputChannel`: For logging tool activity
- `metricsCollector`: For recording tool call latency/results

---

## Codebase Indexing

The indexing pipeline converts the workspace into a searchable vector store for RAG.

```
Workspace Files
    |
    v
+-------------------+
| File Watcher      |  (workspace.createFileSystemWatcher)
+--------+----------+  Detects create/change/delete
         |
         v
+--------+----------+
| Tree-Sitter       |  Parses files into AST
| Chunker           |  Splits into semantic chunks:
+--------+----------+    - functions, classes, methods
         |               - imports, type definitions
         v               - respects token budget per chunk
+--------+----------+
| Embedding Service |  Generates vector embeddings
+--------+----------+    - Ollama: nomic-embed-text (local)
         |               - ONNX Runtime (bundled, offline)
         v               - OpenAI: text-embedding-3-small (cloud)
+--------+----------+
| sqlite-vec         |  Vector store (SQLite extension)
| Vector Store       |    - Stores: chunk_id, file_path, chunk_text,
+-------------------+      start_line, end_line, embedding, metadata
                           - Supports cosine similarity search
                           - Single file: .champ/index.db
```

### Incremental Indexing

Rather than re-indexing the entire workspace on every change:

1. **File watcher** detects changed files
2. **Diff check**: Compare file hash against stored hash in the index
3. **Selective re-chunk**: Only re-parse and re-embed changed files
4. **Upsert**: Replace old chunks for the changed file, insert new ones
5. **Delete**: Remove chunks for deleted files

### Query Pipeline

```
User query / agent context request
    |
    v
+-------------------+
| Query Embedding   |  Embed the query text
+--------+----------+
         |
         v
+--------+----------+
| Vector Search     |  Top-K cosine similarity against sqlite-vec
+--------+----------+
         |
         v
+--------+----------+
| Lexical Search    |  ripgrep for exact matches, symbol names
+--------+----------+
         |
         v
+--------+----------+
| Hybrid Merge      |  Combine and deduplicate results
+--------+----------+  Rank by weighted score (semantic + lexical)
         |
         v
+--------+----------+
| Token Budget      |  Pack results into available context window
| Packer            |  Prioritize by relevance score
+-------------------+
```

---

## Checkpoint System

Checkpoints provide safe rollback for any changes made by the agent system.

### Design

The checkpoint system uses **shadow-copy snapshots** -- full copies of affected files stored in a local directory before any modifications are applied.

```
+-------------------+
| CheckpointManager |
|-------------------|
| + create(label)   |  Snapshot all files about to be modified
| + restore(id)     |  Copy snapshots back to workspace
| + list()          |  List available checkpoints
| + prune(maxAge)   |  Clean up old checkpoints
+--------+----------+
         |
         v
+--------+----------+
| .champ/           |
| checkpoints/      |
|   <id>/           |
|     manifest.json |  { id, label, timestamp, files: [...] }
|     files/        |
|       <hash1>     |  Original file content (named by content hash)
|       <hash2>     |
+-------------------+
```

### Checkpoint Lifecycle

1. **Before Apply**: When the agent system is about to write files, `CheckpointManager.create()` is called
2. **Snapshot**: For each file to be modified, read current contents and save to `.champ/checkpoints/<id>/files/`
3. **Manifest**: Write `manifest.json` listing all snapshotted files with their original paths and content hashes
4. **Apply**: Proceed with the file modifications
5. **Restore** (on user request): Read manifest, copy each snapshot back to its original path
6. **Prune**: Automatic cleanup removes checkpoints older than the configured retention period

### Integration Points

- `champ.restoreCheckpoint` command opens a quickpick of available checkpoints
- The webview shows a "Restore" button after agent-applied changes
- Composer mode creates a checkpoint before applying accepted diffs
- Git integration: optionally create a git commit at checkpoint time

---

## Safety Layer

### Secret Redaction

The `SecretRedactor` (`src/safety/secret-redactor.ts`) scans all text flowing to/from the LLM:

- **Patterns**: Regex-based detection of API keys, tokens, passwords, connection strings, private keys
- **Redaction**: Replace matched secrets with `[REDACTED:<type>]` placeholder
- **Bidirectional**: Applied to both outgoing context (files sent to LLM) and incoming responses (prevent leaking secrets in suggestions)

### Command Sandbox

The `CommandSandbox` (`src/safety/command-sandbox.ts`) restricts terminal command execution:

- **Blocklist**: Commands that are never allowed (e.g., `rm -rf /`, `mkfs`, `dd`, `:(){ :|:& };:`)
- **Allowlist**: Commands that skip approval in yolo mode (e.g., `ls`, `cat`, `git status`, `npm test`)
- **Working directory**: Commands are confined to the workspace root
- **Timeout**: Maximum execution time (default: 30 seconds) to prevent runaway processes
- **Output capture**: stdout/stderr captured and returned to the agent, truncated if exceeding token budget

### Confidence Scoring

The `ConfidenceScorer` (`src/safety/confidence-scorer.ts`) evaluates LLM outputs:

- **Score range**: 0.0 to 1.0
- **Factors**: Response coherence, tool call validity, diff applicability, model self-reported confidence
- **Threshold**: Outputs below the configured threshold (default: 0.3) are rejected and not presented to the user
- **Integration**: The Reviewer Agent uses confidence scoring as one of its review criteria

### Safety Flow

```
LLM Response
    |
    v
+-------------------+
| Secret Redactor   |  Scan and redact any secrets in response
+--------+----------+
         |
         v
+--------+----------+
| Confidence Scorer |  Evaluate response quality
+--------+----------+
         |
    Score >= threshold?
         |
    +----+----+
    |         |
   Yes        No
    |         |
    v         v
  Continue   Reject
  to tool    (log, notify
  execution  agent to retry)
```

---

## Observability

### MetricsCollector

The `MetricsCollector` (`src/observability/metrics.ts`) is a centralized metrics collection service.

### Tracked Metrics

| Metric | Type | Description |
|---|---|---|
| `llm.request.latency` | Histogram | Time from request start to first token (TTFT) and total completion time |
| `llm.request.tokens.input` | Counter | Input tokens per request |
| `llm.request.tokens.output` | Counter | Output tokens per request |
| `llm.request.tokens.total` | Counter | Total tokens per request |
| `agent.step.count` | Counter | Number of steps per agent workflow |
| `agent.step.latency` | Histogram | Time per agent step |
| `agent.workflow.latency` | Histogram | Total workflow execution time |
| `agent.retry.count` | Counter | Number of retries triggered |
| `tool.call.count` | Counter | Tool invocations by tool name |
| `tool.call.latency` | Histogram | Tool execution time |
| `tool.call.failures` | Counter | Failed tool calls by tool name and error type |
| `indexing.files.count` | Gauge | Number of indexed files |
| `indexing.chunks.count` | Gauge | Number of indexed chunks |
| `indexing.latency` | Histogram | Indexing pipeline execution time |
| `completion.latency` | Histogram | Inline autocomplete request latency |
| `completion.accepted` | Counter | Accepted completions |
| `completion.dismissed` | Counter | Dismissed completions |

### Logging

Structured logs are written to a VS Code OutputChannel (`Champ`) and optionally to a file:

```
AgentStepLog {
  workflowId: string
  agentName: string
  stepIndex: number
  timestamp: ISO string
  input: summary (truncated)
  output: summary (truncated)
  toolCalls: ToolCallLog[]
  latencyMs: number
  tokensUsed: { input, output }
  error?: string
}

ToolCallLog {
  toolName: string
  args: Record<string, unknown>
  result: summary (truncated)
  approved: boolean
  latencyMs: number
  error?: string
}
```

### Metrics Exposure

- **Status bar**: Real-time display of model name, token count, and latency for the current session
- **Output channel**: Detailed logs viewable via `Output > Champ`
- **JSON export**: Metrics can be exported for external analysis
- **Webview**: The StatusBar component in the chat UI shows per-message token usage and latency
