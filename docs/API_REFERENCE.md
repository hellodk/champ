# AIDev API Reference

This document defines all TypeScript interfaces, types, and enums that form the public contract of the AIDev extension's internal modules. These types are the single source of truth; all implementations must conform to them.

---

## Table of Contents

1. [LLM Provider Types](#llm-provider-types)
2. [Tool Types](#tool-types)
3. [Agent Types](#agent-types)
4. [Chat View Provider Protocol](#chat-view-provider-protocol)
5. [Checkpoint Types](#checkpoint-types)
6. [Indexing Types](#indexing-types)
7. [Observability Types](#observability-types)
8. [Rules Types](#rules-types)
9. [Model Router and Provider Registry](#model-router-and-provider-registry)
10. [Upload Types](#upload-types)
11. [Completion Types](#completion-types)
12. [Composer Types](#composer-types)
13. [Safety Types](#safety-types)
14. [MCP Types](#mcp-types)
15. [Session Memory](#session-memory)

---

## LLM Provider Types

```typescript
/**
 * Unified interface for all LLM providers.
 * Implementations: ClaudeProvider, OpenAIProvider, GeminiProvider,
 * OllamaProvider, LlamaCppProvider, VLLMProvider, OpenAICompatibleProvider
 */
export interface LLMProvider {
  readonly name: string;
  readonly config: LLMProviderConfig;

  /**
   * Send a chat-style request with message history.
   * Returns an async iterable of streaming deltas.
   */
  chat(
    messages: LLMMessage[],
    options?: ChatOptions
  ): AsyncIterable<StreamDelta>;

  /**
   * Send a completion-style request (single prompt, no history).
   * Used for inline autocomplete (FIM).
   */
  complete(
    prompt: string,
    options?: CompleteOptions
  ): AsyncIterable<StreamDelta>;

  /**
   * Whether this provider supports native tool_use in the API.
   * If false, the prompt-based XML tool calling template is used.
   */
  supportsToolUse(): boolean;

  /**
   * Whether this provider supports streaming responses.
   */
  supportsStreaming(): boolean;

  /**
   * Count tokens for the given text using the provider's tokenizer.
   */
  countTokens(text: string): number;

  /**
   * Return metadata about the currently configured model.
   */
  modelInfo(): ModelInfo;

  /**
   * Dispose of any resources (HTTP connections, etc.).
   */
  dispose(): void;
}

/**
 * Configuration for an LLM provider instance.
 */
export interface LLMProviderConfig {
  /** Provider identifier: claude, openai, gemini, ollama, llamacpp, vllm, openai-compatible */
  provider: string;

  /** Model identifier (e.g., "claude-sonnet-4-20250514", "gpt-4o", "llama3.1") */
  model: string;

  /** API key for cloud providers. Undefined for local providers. */
  apiKey?: string;

  /** Base URL for the API endpoint. Required for local providers. */
  baseUrl?: string;

  /** Maximum tokens to generate in a response. */
  maxTokens?: number;

  /** Sampling temperature (0.0 - 2.0). */
  temperature?: number;

  /** Nucleus sampling parameter. */
  topP?: number;

  /** Repetition penalty for local models. */
  repeatPenalty?: number;

  /** Stop sequences. */
  stop?: string[];

  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * A message in the LLM conversation.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlock[] | string;

  /** For tool result messages: the tool call ID this responds to. */
  toolCallId?: string;

  /** For assistant messages: tool calls the assistant wants to make. */
  toolCalls?: ToolCall[];
}

/**
 * A content block within a message. Supports text, images, and tool use.
 */
export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  /** Base64-encoded image data. */
  data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * A tool call requested by the LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A streaming delta from the LLM.
 */
export interface StreamDelta {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done' | 'error';

  /** Text content delta (for type === 'text'). */
  text?: string;

  /** Tool call information (for tool_call_* types). */
  toolCall?: Partial<ToolCall>;

  /** Usage information (for type === 'done'). */
  usage?: TokenUsage;

  /** Error message (for type === 'error'). */
  error?: string;
}

/**
 * Token usage statistics for a request.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Chat request options.
 */
export interface ChatOptions {
  /** Tool definitions available for this request. */
  tools?: ToolDefinition[];

  /** Maximum tokens to generate. Overrides provider config. */
  maxTokens?: number;

  /** Temperature override. */
  temperature?: number;

  /** Abort signal for cancellation. */
  signal?: AbortSignal;

  /** System prompt override (appended to base system prompt). */
  systemPrompt?: string;
}

/**
 * Completion request options (for inline autocomplete).
 */
export interface CompleteOptions {
  /** Maximum tokens to generate. */
  maxTokens?: number;

  /** Temperature (typically low for autocomplete, e.g., 0.1). */
  temperature?: number;

  /** Abort signal for cancellation. */
  signal?: AbortSignal;

  /** Fill-in-middle suffix (text after the cursor). */
  suffix?: string;
}

/**
 * A tool definition as provided to the LLM.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/**
 * JSON Schema for tool parameters.
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required?: string[];
}

/**
 * Metadata about the currently configured model.
 */
export interface ModelInfo {
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  /** Estimated cost per 1M input tokens in USD. Undefined for local models. */
  inputCostPer1M?: number;
  /** Estimated cost per 1M output tokens in USD. Undefined for local models. */
  outputCostPer1M?: number;
}
```

---

## Tool Types

```typescript
/**
 * A tool that can be registered with the ToolRegistry and invoked by agents.
 */
export interface Tool {
  /** Unique tool name (e.g., "read_file", "run_terminal"). */
  readonly name: string;

  /** Human-readable description shown to the LLM. */
  readonly description: string;

  /** Parameter schema for the tool. */
  readonly parameters: ToolParameter[];

  /**
   * Whether this tool requires user approval before execution.
   * If true and yoloMode is false, the UI prompts the user.
   */
  readonly requiresApproval: boolean;

  /**
   * Execute the tool with the given arguments.
   */
  execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult>;
}

/**
 * A single parameter definition for a tool.
 */
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required: boolean;
  /** Allowed values (enum). */
  enum?: string[];
  /** Default value. */
  default?: unknown;
  /** For array type: schema of items. */
  items?: { type: string };
}

/**
 * Result returned by a tool execution.
 */
export interface ToolResult {
  /** Whether the tool executed successfully. */
  success: boolean;

  /** The output content to send back to the LLM. */
  output: string;

  /** Optional structured data (not sent to LLM, used internally). */
  data?: Record<string, unknown>;

  /** Error message if success is false. */
  error?: string;
}

/**
 * Context provided to every tool execution.
 */
export interface ToolExecutionContext {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;

  /** Relative path to the currently active file (if any). */
  activeFile?: string;

  /** Cancellation token for aborting long-running tools. */
  cancellationToken: { isCancellationRequested: boolean };

  /** Output channel for logging tool activity. */
  outputChannel: {
    appendLine(message: string): void;
  };

  /** Metrics collector for recording tool call metrics. */
  metricsCollector: MetricsCollector;

  /** Whether yolo mode is enabled (skip approval). */
  yoloMode: boolean;
}

/**
 * The tool registry that manages all available tools.
 */
export interface ToolRegistry {
  /** Register a tool. Throws if a tool with the same name already exists. */
  register(tool: Tool): void;

  /** Get a tool by name. Returns undefined if not found. */
  get(name: string): Tool | undefined;

  /** List all registered tools. */
  list(): Tool[];

  /** Get tool definitions formatted for LLM consumption. */
  getDefinitions(): ToolDefinition[];

  /**
   * Execute a tool by name with the given arguments.
   * Handles approval flow and metrics recording.
   */
  execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult>;
}
```

---

## Agent Types

```typescript
/**
 * Base interface for all agents.
 */
export interface Agent {
  /** Unique agent identifier. */
  readonly name: string;

  /** Human-readable description. */
  readonly description: string;

  /**
   * Execute the agent's task.
   */
  execute(input: AgentInput): Promise<AgentOutput>;
}

/**
 * Input provided to an agent when it is invoked.
 */
export interface AgentInput {
  /** The task or instruction for this agent. */
  task: string;

  /** Shared memory accessible by all agents in the workflow. */
  sharedMemory: SharedMemory;

  /** LLM provider to use for this agent's requests. */
  provider: LLMProvider;

  /** Tool registry for agents that use tools. */
  toolRegistry: ToolRegistry;

  /** Conversation history relevant to this agent. */
  messages: LLMMessage[];

  /** Maximum retries for this agent step. */
  maxRetries: number;

  /** Abort signal for cancellation. */
  signal?: AbortSignal;

  /** Callback for streaming progress updates to the UI. */
  onProgress?: (event: AgentProgressEvent) => void;
}

/**
 * Output returned by an agent after execution.
 */
export interface AgentOutput {
  /** Whether the agent completed successfully. */
  success: boolean;

  /** The agent's result data (agent-specific structure). */
  result: Record<string, unknown>;

  /** Tool calls made during execution. */
  toolCalls: ToolCallRecord[];

  /** Token usage for this agent step. */
  usage: TokenUsage;

  /** Execution time in milliseconds. */
  latencyMs: number;

  /** Error message if success is false. */
  error?: string;
}

/**
 * A record of a tool call made during agent execution.
 */
export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  approved: boolean;
  latencyMs: number;
}

/**
 * Progress event emitted by agents during execution.
 */
export interface AgentProgressEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'complete' | 'error';
  agentName: string;
  message?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  text?: string;
}

/**
 * Shared memory accessible by all agents during a workflow execution.
 */
export interface SharedMemory {
  /** The original user request. */
  taskDescription: string;

  /** Structured plan from the Planner Agent. */
  plan?: PlanResult;

  /** Retrieved context chunks from the Context Agent. */
  contextChunks: ContextChunk[];

  /** Generated diffs from the Code Agent. */
  diffs: DiffResult[];

  /** Review result from the Reviewer Agent. */
  reviewResult?: ReviewResult;

  /** Validation result from the Validator Agent. */
  validationResult?: ValidationResult;

  /** Uploaded file processing results from the File Agent. */
  uploadedFiles: FileProcessingResult[];

  /** Messages passed between agents. */
  messages: AgentMessage[];

  /** Arbitrary key-value metadata for inter-agent communication. */
  metadata: Record<string, unknown>;
}

/**
 * A message passed between agents via shared memory.
 */
export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  type: 'data' | 'error' | 'retry-request';
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * The structured plan produced by the Planner Agent.
 */
export interface PlanResult {
  summary: string;
  steps: PlanStep[];
  affectedFiles: string[];
  risks: string[];
}

export interface PlanStep {
  id: number;
  action: 'read' | 'write' | 'edit' | 'search' | 'terminal' | 'test' | 'lint';
  description: string;
  files: string[];
  dependsOn: number[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

/**
 * A diff result produced by the Code Agent.
 */
export interface DiffResult {
  file: string;
  action: 'create' | 'edit' | 'delete';
  diff: string;
  fullContent?: string;
  explanation: string;
}

/**
 * A context chunk retrieved by the Context Agent.
 */
export interface ContextChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  relevanceScore: number;
  source: 'semantic' | 'lexical' | 'direct-read';
}

/**
 * Review result from the Reviewer Agent.
 */
export interface ReviewResult {
  approved: boolean;
  confidence: number;
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'suggestion';
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

/**
 * Validation result from the Validator Agent.
 */
export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  summary: string;
}

export interface ValidationCheck {
  name: 'lint' | 'typecheck' | 'test';
  passed: boolean;
  output: string;
  errors: ValidationError[];
}

export interface ValidationError {
  file: string;
  line?: number;
  message: string;
}

/**
 * The AgentOrchestrator manages multi-agent workflow execution.
 */
export interface AgentOrchestrator {
  /**
   * Execute a workflow defined by a DAG of agents.
   */
  execute(
    workflow: WorkflowDefinition,
    input: WorkflowInput
  ): Promise<WorkflowResult>;

  /**
   * Cancel a running workflow.
   */
  cancel(workflowId: string): void;

  /**
   * Get the status of a running or completed workflow.
   */
  getStatus(workflowId: string): WorkflowStatus;
}

/**
 * A workflow definition: a DAG of agent nodes.
 */
export interface WorkflowDefinition {
  /** Unique workflow type identifier (e.g., "agent-mode", "composer"). */
  name: string;

  /** Ordered list of agent nodes with dependency edges. */
  nodes: WorkflowNode[];
}

export interface WorkflowNode {
  /** Agent name. */
  agentName: string;

  /** Node IDs this node depends on (must complete first). */
  dependsOn: string[];

  /** Condition for executing this node (optional). */
  condition?: WorkflowCondition;

  /** Maximum retries for this node. */
  maxRetries: number;
}

export interface WorkflowCondition {
  /** The field in SharedMemory to evaluate. */
  field: string;

  /** The operator. */
  operator: 'equals' | 'not_equals' | 'truthy' | 'falsy';

  /** The value to compare against. */
  value?: unknown;
}

/**
 * Input to start a workflow.
 */
export interface WorkflowInput {
  /** The user's message. */
  userMessage: string;

  /** Pre-populated context (current file, selection, etc.). */
  context: Record<string, unknown>;

  /** The LLM provider to use. */
  provider: LLMProvider;

  /** Tool registry. */
  toolRegistry: ToolRegistry;

  /** Callback for progress events. */
  onProgress?: (event: AgentProgressEvent) => void;
}

/**
 * The result of a completed workflow.
 */
export interface WorkflowResult {
  /** Unique workflow execution ID. */
  workflowId: string;

  /** Whether the workflow completed successfully. */
  success: boolean;

  /** Per-agent outputs keyed by agent name. */
  agentOutputs: Record<string, AgentOutput>;

  /** Final shared memory state. */
  sharedMemory: SharedMemory;

  /** Total execution time in milliseconds. */
  totalLatencyMs: number;

  /** Aggregated token usage across all agents. */
  totalUsage: TokenUsage;

  /** Error message if the workflow failed. */
  error?: string;
}

/**
 * Status of a workflow execution.
 */
export interface WorkflowStatus {
  workflowId: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentAgent?: string;
  completedAgents: string[];
  startedAt: string;
  completedAt?: string;
}
```

---

## Chat View Provider Protocol

The `ChatViewProvider` (`src/ui/chat-view-provider.ts`) communicates with the React webview via `postMessage`. All messages conform to these discriminated union types.

```typescript
/**
 * Messages sent from the Extension Host to the Webview.
 */
export type ExtensionToWebviewMessage =
  | { type: 'stream-start'; messageId: string; mode: ChatMode }
  | { type: 'stream-delta'; messageId: string; text: string }
  | { type: 'stream-tool-call'; messageId: string; toolCall: ToolCall }
  | { type: 'stream-tool-result'; messageId: string; toolResult: ToolResult; toolName: string }
  | { type: 'stream-end'; messageId: string; usage: TokenUsage; latencyMs: number }
  | { type: 'stream-error'; messageId: string; error: string }
  | { type: 'agent-progress'; messageId: string; event: AgentProgressEvent }
  | { type: 'diff-view'; messageId: string; diffs: DiffResult[] }
  | { type: 'approval-request'; requestId: string; toolName: string; args: Record<string, unknown>; description: string }
  | { type: 'checkpoint-created'; checkpointId: string; label: string }
  | { type: 'mode-changed'; mode: ChatMode }
  | { type: 'upload-accepted'; fileName: string; tokens: number }
  | { type: 'upload-error'; fileName: string; error: string }
  | { type: 'indexing-progress'; filesIndexed: number; totalFiles: number; status: 'indexing' | 'complete' | 'error' }
  | { type: 'conversation-history'; messages: ConversationMessage[] }
  | { type: 'config-update'; config: WebviewConfig };

/**
 * Messages sent from the Webview to the Extension Host.
 */
export type WebviewToExtensionMessage =
  | { type: 'send-message'; text: string; attachments?: FileAttachment[]; contextRefs?: ContextReference[] }
  | { type: 'cancel' }
  | { type: 'set-mode'; mode: ChatMode }
  | { type: 'approval-response'; requestId: string; approved: boolean }
  | { type: 'diff-action'; messageId: string; file: string; action: 'accept' | 'reject'; hunkIndex?: number }
  | { type: 'restore-checkpoint'; checkpointId: string }
  | { type: 'upload-file'; file: FileAttachment }
  | { type: 'remove-upload'; fileName: string }
  | { type: 'new-chat' }
  | { type: 'get-conversation-history' }
  | { type: 'retry-message'; messageId: string }
  | { type: 'copy-code'; code: string }
  | { type: 'insert-code'; code: string; file?: string }
  | { type: 'open-file'; path: string; line?: number }
  | { type: 'webview-ready' };

/**
 * Chat mode enum.
 */
export type ChatMode = 'agent' | 'ask' | 'manual' | 'plan' | 'composer';

/**
 * A message in the conversation history displayed in the webview.
 */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  mode: ChatMode;
  toolCalls?: ToolCall[];
  toolResults?: Array<{ toolName: string; result: ToolResult }>;
  diffs?: DiffResult[];
  usage?: TokenUsage;
  latencyMs?: number;
  attachments?: FileAttachment[];
}

/**
 * A file attachment from the webview.
 */
export interface FileAttachment {
  name: string;
  content: string;
  mimeType: string;
  size: number;
}

/**
 * A context reference from @-symbol mentions.
 */
export interface ContextReference {
  type: 'file' | 'symbol' | 'folder' | 'git' | 'docs' | 'web' | 'upload';
  value: string;
}

/**
 * Configuration sent to the webview.
 */
export interface WebviewConfig {
  mode: ChatMode;
  provider: string;
  model: string;
  yoloMode: boolean;
  autocompleteEnabled: boolean;
}
```

---

## Checkpoint Types

```typescript
/**
 * A checkpoint representing a point-in-time snapshot of workspace files.
 */
export interface Checkpoint {
  /** Unique checkpoint identifier (UUID). */
  id: string;

  /** Human-readable label (e.g., "Before refactoring auth module"). */
  label: string;

  /** ISO timestamp of checkpoint creation. */
  timestamp: string;

  /** List of file snapshots in this checkpoint. */
  files: FileSnapshot[];
}

/**
 * A snapshot of a single file at checkpoint time.
 */
export interface FileSnapshot {
  /** Relative path from workspace root. */
  relativePath: string;

  /** Content hash (SHA-256) used as the storage filename. */
  contentHash: string;

  /** File size in bytes. */
  sizeBytes: number;

  /** Whether the file existed at checkpoint time (false if it was about to be created). */
  existed: boolean;
}

/**
 * Manages checkpoint creation, restoration, and cleanup.
 */
export interface CheckpointManager {
  /**
   * Create a checkpoint for the given files.
   * Reads current contents and stores them.
   */
  create(label: string, filePaths: string[]): Promise<Checkpoint>;

  /**
   * Restore a checkpoint by copying snapshots back.
   */
  restore(checkpointId: string): Promise<void>;

  /**
   * List all available checkpoints, newest first.
   */
  list(): Promise<Checkpoint[]>;

  /**
   * Delete a specific checkpoint and its stored files.
   */
  delete(checkpointId: string): Promise<void>;

  /**
   * Remove checkpoints older than maxAgeMs.
   */
  prune(maxAgeMs: number): Promise<number>;
}
```

---

## Indexing Types

```typescript
/**
 * A chunk of code extracted from a source file.
 */
export interface CodeChunk {
  /** Unique chunk identifier. */
  id: string;

  /** Relative file path from workspace root. */
  filePath: string;

  /** The chunk text content. */
  content: string;

  /** Start line in the original file (1-based). */
  startLine: number;

  /** End line in the original file (1-based). */
  endLine: number;

  /** Programming language of the chunk. */
  language: string;

  /** Kind of code element (function, class, interface, import, block). */
  kind: ChunkKind;

  /** Token count for this chunk. */
  tokenCount: number;

  /** Content hash for change detection. */
  contentHash: string;
}

export type ChunkKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'import'
  | 'export'
  | 'block'
  | 'comment'
  | 'file';

/**
 * Service that generates vector embeddings for text.
 */
export interface EmbeddingService {
  /**
   * Generate embeddings for one or more text inputs.
   * Returns a 2D array: one embedding vector per input.
   */
  embed(texts: string[]): Promise<number[][]>;

  /**
   * The dimensionality of the embedding vectors.
   */
  dimensions(): number;

  /**
   * The name of the embedding model.
   */
  modelName(): string;
}

/**
 * Vector store for storing and querying embeddings.
 */
export interface VectorStore {
  /**
   * Insert or update chunks with their embeddings.
   */
  upsert(entries: VectorEntry[]): Promise<void>;

  /**
   * Query for similar chunks.
   */
  query(
    embedding: number[],
    topK: number,
    filter?: VectorFilter
  ): Promise<VectorSearchResult[]>;

  /**
   * Delete all chunks for a given file path.
   */
  deleteByFile(filePath: string): Promise<void>;

  /**
   * Delete all entries in the store.
   */
  clear(): Promise<void>;

  /**
   * Get the total number of stored entries.
   */
  count(): Promise<number>;

  /**
   * Close the database connection.
   */
  close(): Promise<void>;
}

export interface VectorEntry {
  id: string;
  filePath: string;
  content: string;
  embedding: number[];
  startLine: number;
  endLine: number;
  language: string;
  kind: ChunkKind;
  contentHash: string;
}

export interface VectorSearchResult {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  language: string;
  kind: ChunkKind;
}

export interface VectorFilter {
  /** Filter to specific file paths. */
  filePaths?: string[];

  /** Filter to specific languages. */
  languages?: string[];

  /** Filter to specific chunk kinds. */
  kinds?: ChunkKind[];
}

/**
 * The indexing service that coordinates chunking, embedding, and storage.
 */
export interface IndexingService {
  /**
   * Index the entire workspace. Performs incremental indexing
   * if a prior index exists.
   */
  indexWorkspace(): Promise<IndexingResult>;

  /**
   * Index specific files (called on file change events).
   */
  indexFiles(filePaths: string[]): Promise<IndexingResult>;

  /**
   * Remove files from the index (called on file delete events).
   */
  removeFiles(filePaths: string[]): Promise<void>;

  /**
   * Search the index with a text query.
   */
  search(query: string, topK?: number): Promise<VectorSearchResult[]>;

  /**
   * Get indexing statistics.
   */
  stats(): Promise<IndexingStats>;

  /**
   * Register a callback for indexing progress events.
   */
  onProgress(callback: (event: IndexingProgressEvent) => void): void;

  /**
   * Dispose of resources (close DB, stop file watcher).
   */
  dispose(): void;
}

export interface IndexingResult {
  filesProcessed: number;
  chunksCreated: number;
  chunksUpdated: number;
  chunksDeleted: number;
  latencyMs: number;
  errors: Array<{ filePath: string; error: string }>;
}

export interface IndexingStats {
  totalFiles: number;
  totalChunks: number;
  totalTokens: number;
  dbSizeBytes: number;
  lastIndexedAt?: string;
}

export interface IndexingProgressEvent {
  status: 'started' | 'indexing' | 'embedding' | 'storing' | 'complete' | 'error';
  filesProcessed: number;
  totalFiles: number;
  currentFile?: string;
  error?: string;
}
```

---

## Observability Types

```typescript
/**
 * Centralized metrics collector.
 */
export interface MetricsCollector {
  /**
   * Record a numeric metric value.
   */
  record(name: string, value: number, tags?: Record<string, string>): void;

  /**
   * Increment a counter metric.
   */
  increment(name: string, tags?: Record<string, string>): void;

  /**
   * Start a timer. Returns a function that, when called, records the elapsed time.
   */
  startTimer(name: string, tags?: Record<string, string>): () => number;

  /**
   * Log an agent step.
   */
  logAgentStep(log: AgentStepLog): void;

  /**
   * Log a tool call.
   */
  logToolCall(log: ToolCallLog): void;

  /**
   * Get all collected metrics.
   */
  getMetrics(): Metrics;

  /**
   * Get agent step logs for a specific workflow.
   */
  getAgentLogs(workflowId?: string): AgentStepLog[];

  /**
   * Export metrics as JSON.
   */
  exportJSON(): string;

  /**
   * Reset all collected metrics.
   */
  reset(): void;
}

/**
 * Aggregated metrics snapshot.
 */
export interface Metrics {
  /** Counters keyed by metric name. */
  counters: Record<string, number>;

  /** Histograms keyed by metric name (array of recorded values). */
  histograms: Record<string, number[]>;

  /** Current session token usage. */
  sessionTokens: TokenUsage;

  /** Total number of LLM requests in this session. */
  totalRequests: number;

  /** Total number of tool calls in this session. */
  totalToolCalls: number;

  /** Total number of agent workflow runs in this session. */
  totalWorkflows: number;

  /** Session start time. */
  sessionStartedAt: string;
}

/**
 * A log entry for a single agent step in a workflow.
 */
export interface AgentStepLog {
  workflowId: string;
  agentName: string;
  stepIndex: number;
  timestamp: string;
  input: string;
  output: string;
  toolCalls: ToolCallLog[];
  latencyMs: number;
  tokensUsed: TokenUsage;
  error?: string;
}

/**
 * A log entry for a single tool call.
 */
export interface ToolCallLog {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  approved: boolean;
  latencyMs: number;
  error?: string;
}
```

---

## Rules Types

```typescript
/**
 * The rules engine that loads and merges rules from all sources.
 */
export interface RulesEngine {
  /**
   * Load rules from all sources (user settings, project files, directory files).
   */
  load(): Promise<void>;

  /**
   * Get merged rules for a specific file path.
   * Includes global, project, and applicable directory rules.
   */
  getRulesForFile(filePath: string): Rule[];

  /**
   * Get all rules formatted as a prompt injection string.
   */
  getPromptInjection(filePath?: string): string;

  /**
   * Reload rules (called when configuration changes).
   */
  reload(): Promise<void>;
}

/**
 * A single rule.
 */
export interface Rule {
  /** The rule text. */
  text: string;

  /** Where this rule came from. */
  source: RuleSource;

  /** The type/scope of this rule. */
  type: RuleType;

  /** For directory rules: the directory path this rule applies to. */
  scope?: string;
}

/**
 * Where a rule was defined.
 */
export type RuleSource = 'user-settings' | 'project-file' | 'directory-file';

/**
 * The scope type of a rule.
 */
export type RuleType = 'global' | 'project' | 'directory';
```

---

## Model Router and Provider Registry

```typescript
/**
 * Routes task types to appropriate provider/model combinations.
 */
export interface ModelRouter {
  /**
   * Get the provider for a specific task type.
   */
  getProvider(task: ModelTask): LLMProvider;

  /**
   * Get the model info for a specific task type.
   */
  getModelInfo(task: ModelTask): ModelInfo;

  /**
   * Update routing when configuration changes.
   */
  refresh(): void;
}

/**
 * Task types that the model router can route.
 */
export type ModelTask = 'chat' | 'agent' | 'autocomplete' | 'embedding';

/**
 * Registry that manages all LLM provider instances.
 */
export interface ProviderRegistry {
  /**
   * Register a provider instance.
   */
  register(name: string, provider: LLMProvider): void;

  /**
   * Get a provider by name.
   */
  get(name: string): LLMProvider | undefined;

  /**
   * Get the currently active provider (from settings).
   */
  getActive(): LLMProvider;

  /**
   * List all registered provider names.
   */
  list(): string[];

  /**
   * Dispose of all providers.
   */
  dispose(): void;
}
```

---

## Upload Types

```typescript
/**
 * Service that handles file uploads from the webview.
 */
export interface FileUploadService {
  /**
   * Process an uploaded file.
   */
  process(attachment: FileAttachment): Promise<FileProcessingResult>;

  /**
   * Get all uploaded files in the current session.
   */
  getSessionFiles(): FileProcessingResult[];

  /**
   * Remove an uploaded file from the session.
   */
  remove(fileName: string): void;

  /**
   * Clear all uploaded files.
   */
  clear(): void;
}

/**
 * Parser that converts raw file content into structured text.
 */
export interface FileParser {
  /**
   * Whether this parser can handle the given MIME type.
   */
  canParse(mimeType: string): boolean;

  /**
   * Parse the file content into text.
   */
  parse(content: string, mimeType: string): Promise<string>;
}

/**
 * Result of processing an uploaded file.
 */
export interface FileProcessingResult {
  fileName: string;
  fileType: 'code' | 'text' | 'json' | 'yaml' | 'markdown' | 'log' | 'pdf' | 'binary';
  totalTokens: number;
  chunks: FileChunk[];
  summary: string;
  indexed: boolean;
}

/**
 * A chunk of an uploaded file.
 */
export interface FileChunk {
  index: number;
  content: string;
  tokens: number;
  metadata: Record<string, unknown>;
}

/**
 * Session memory for uploaded files and ephemeral context.
 */
export interface SessionMemory {
  /** Uploaded files for the current session. */
  uploadedFiles: FileProcessingResult[];

  /** Conversation history. */
  conversationHistory: LLMMessage[];

  /** Current mode. */
  mode: ChatMode;

  /** Session-scoped metadata. */
  metadata: Record<string, unknown>;

  /**
   * Get the total token count of all session context.
   */
  totalTokens(): number;

  /**
   * Clear the session.
   */
  clear(): void;
}
```

---

## Completion Types

```typescript
/**
 * Context gathered for an inline completion request.
 */
export interface CompletionContext {
  /** Text before the cursor in the current file. */
  prefix: string;

  /** Text after the cursor in the current file. */
  suffix: string;

  /** Language ID of the current file (e.g., "typescript", "python"). */
  language: string;

  /** Relative path of the current file. */
  filePath: string;

  /** Line number of the cursor (0-based). */
  line: number;

  /** Column number of the cursor (0-based). */
  column: number;

  /** Import statements from the current file. */
  imports: string[];

  /** Snippets from other open tabs for cross-file context. */
  openTabSnippets: TabSnippet[];
}

/**
 * A snippet from an open tab used for cross-file context.
 */
export interface TabSnippet {
  filePath: string;
  language: string;
  content: string;
  relevanceScore: number;
}

/**
 * Configuration for the inline completion provider.
 */
export interface CompletionConfig {
  /** Whether autocomplete is enabled. */
  enabled: boolean;

  /** Debounce delay in milliseconds. */
  debounceMs: number;

  /** Model to use for completions. */
  model: string;

  /** Maximum tokens to generate per completion. */
  maxTokens: number;

  /** Temperature for completion sampling. */
  temperature: number;

  /** Maximum prefix characters to include. */
  maxPrefixChars: number;

  /** Maximum suffix characters to include. */
  maxSuffixChars: number;
}
```

---

## Composer Types

```typescript
/**
 * The composer service that orchestrates multi-file edits.
 */
export interface ComposerService {
  /**
   * Generate a multi-file edit plan and diffs for a user request.
   */
  compose(request: ComposerRequest): Promise<ComposerResult>;

  /**
   * Apply accepted diffs to the workspace.
   */
  apply(diffs: ApprovedDiff[]): Promise<ApplyResult>;
}

export interface ComposerRequest {
  /** The user's change request. */
  message: string;

  /** Context references from @-mentions. */
  contextRefs: ContextReference[];

  /** LLM provider to use. */
  provider: LLMProvider;

  /** Progress callback. */
  onProgress?: (event: AgentProgressEvent) => void;
}

export interface ComposerResult {
  /** Plan summary. */
  plan: PlanResult;

  /** Generated diffs for each file. */
  diffs: DiffResult[];

  /** Token usage. */
  usage: TokenUsage;

  /** Total latency. */
  latencyMs: number;
}

export interface ApprovedDiff {
  file: string;
  diff: string;
  fullContent?: string;
  action: 'create' | 'edit' | 'delete';
  /** Which hunks were approved (if per-hunk approval). Empty means all approved. */
  approvedHunks: number[];
}

export interface ApplyResult {
  success: boolean;
  filesModified: string[];
  checkpointId?: string;
  errors: Array<{ file: string; error: string }>;
}
```

---

## Safety Types

```typescript
/**
 * Service that redacts secrets from text.
 */
export interface SecretRedactor {
  /**
   * Scan text and replace detected secrets with redaction placeholders.
   */
  redact(text: string): RedactionResult;
}

export interface RedactionResult {
  /** The text with secrets replaced by [REDACTED:<type>]. */
  redactedText: string;

  /** Number of secrets found and redacted. */
  redactionCount: number;

  /** Types of secrets found. */
  secretTypes: string[];
}

/**
 * Sandbox that restricts and validates terminal commands.
 */
export interface CommandSandbox {
  /**
   * Validate whether a command is allowed to execute.
   */
  validate(command: string): CommandValidation;

  /**
   * Execute a command within the sandbox constraints.
   */
  execute(command: string, workspaceRoot: string): Promise<CommandResult>;
}

export interface CommandValidation {
  allowed: boolean;
  reason?: string;
  requiresApproval: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Service that scores the confidence of LLM outputs.
 */
export interface ConfidenceScorer {
  /**
   * Score an LLM response for confidence.
   */
  score(response: string, context: ConfidenceContext): ConfidenceScore;
}

export interface ConfidenceContext {
  /** The original request. */
  request: string;

  /** The tool calls made (if any). */
  toolCalls: ToolCall[];

  /** The model that generated the response. */
  model: string;
}

export interface ConfidenceScore {
  /** Overall confidence score (0.0 - 1.0). */
  overall: number;

  /** Breakdown by factor. */
  factors: Record<string, number>;

  /** Whether the score exceeds the configured threshold. */
  aboveThreshold: boolean;
}
```

---

## MCP Types

```typescript
/**
 * Configuration for an MCP (Model Context Protocol) server.
 */
export interface MCPServerConfig {
  /** Unique server name. */
  name: string;

  /** Command to start the server. */
  command: string;

  /** Arguments to the command. */
  args: string[];

  /** Environment variables for the server process. */
  env: Record<string, string>;
}

/**
 * Client that manages connections to MCP servers.
 */
export interface MCPClient {
  /**
   * Connect to an MCP server.
   */
  connect(config: MCPServerConfig): Promise<void>;

  /**
   * Disconnect from an MCP server.
   */
  disconnect(serverName: string): Promise<void>;

  /**
   * List tools available from all connected MCP servers.
   */
  listTools(): Promise<MCPTool[]>;

  /**
   * Call a tool on an MCP server.
   */
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult>;

  /**
   * List all connected server names.
   */
  connectedServers(): string[];

  /**
   * Dispose of all connections.
   */
  dispose(): void;
}

/**
 * A tool provided by an MCP server.
 */
export interface MCPTool {
  /** Server that provides this tool. */
  serverName: string;

  /** Tool name. */
  name: string;

  /** Tool description. */
  description: string;

  /** Input schema. */
  inputSchema: Record<string, unknown>;
}
```
