/**
 * LLM Provider type contracts.
 *
 * All providers (Claude, OpenAI, Gemini, Ollama, llama.cpp, vLLM,
 * OpenAI-compatible) implement the LLMProvider interface. The agent layer
 * interacts with providers only through this interface.
 */

/**
 * Role of a message in the conversation history.
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * A block of content within a message. Messages may be plain strings or an
 * array of content blocks (used for multimodal input and tool results).
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; imageData: string; mimeType: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

/**
 * A single message in the conversation history.
 */
export interface LLMMessage {
  role: MessageRole;
  content: string | ContentBlock[];
  /** For role='tool' messages, the ID of the tool call being responded to. */
  toolCallId?: string;
  /** For role='assistant' messages that invoke tools. */
  toolCalls?: ToolCall[];
}

/**
 * A request to invoke a tool, emitted by the model during generation.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * JSON Schema subset used for tool parameter definitions.
 */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }
  >;
  required: string[];
}

/**
 * Definition of a tool exposed to the LLM. Passed to the provider alongside
 * messages so the model can decide to invoke tools.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/**
 * Streaming delta emitted by a provider during chat/completion.
 */
export type StreamDelta =
  | { type: "text"; text: string }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_call_delta"; toolCallId: string; argumentsDelta: string }
  | {
      type: "tool_call_end";
      toolCallId?: string;
      toolName?: string;
      toolResult?: string;
      toolSuccess?: boolean;
      fileEditDiff?: { path: string; oldContent: string; newContent: string };
    }
  | { type: "done"; usage: TokenUsage }
  | { type: "error"; error: string }
  | {
      type: "terminal_chunk";
      executionId: string;
      chunk: string;
      done: boolean;
    };

/**
 * Token accounting for a single request.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Static metadata about a model. Used by the agent layer to decide things
 * like context budget and whether to use native tool calling.
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsToolUse: boolean;
  supportsImages: boolean;
  supportsStreaming: boolean;
}

/**
 * Configuration required to instantiate a provider.
 */
export interface LLMProviderConfig {
  /** Provider identifier (claude, openai, gemini, ollama, llamacpp, vllm, openai-compatible). */
  provider: string;
  /** Model identifier. */
  model: string;
  /** API key for cloud providers. Not required for local providers. */
  apiKey?: string;
  /** Base URL for the API. Required for local and OpenAI-compatible providers. */
  baseUrl?: string;
  /** Maximum tokens to generate in a response. */
  maxTokens: number;
  /** Sampling temperature (0..1). */
  temperature: number;
  /** Optional nucleus sampling parameter. */
  topP?: number;
  /** Additional headers to include on requests. */
  customHeaders?: Record<string, string>;
  /**
   * Cap the effective context window (tokens). When set, the provider never
   * uses more than this window even if the runtime advertises a larger one
   * (e.g. num_ctx override). Ticket #119.
   */
  contextWindow?: number;
  /**
   * Per-provider decode overrides from the YAML `options:` block (ticket
   * #120). Explicit per-request options win over these; these win over the
   * task decode profile.
   */
  options?: DecodeParams;
  /** Per-request HTTP timeout in ms before first token. Default: 120000 (issue #104). */
  requestTimeoutMs?: number;
  /**
   * Opt-in to native OpenAI tool calling for openai-compatible servers.
   * Default false — champ falls back to prompt-based XML tools. Set true
   * when your server implements OpenAI-spec `tools` reliably (vLLM, omlx,
   * llama.cpp server, LM Studio with a tool-capable model).
   */
  supportsTools?: boolean;
  /**
   * Opt-in to JSON-constrained generation on chat requests (#121). When set,
   * the provider pins its backend's structured-output field
   * (`response_format: {type:"json_object"}` / `format: "json"`). Never
   * applied on tool-call turns — the XML tool prompt needs free text.
   */
  structuredOutput?: boolean;
  /**
   * Ask the backend to keep the prompt/KV cache warm between turns (#121).
   * ollama: `options.cache_prompt: true`. Improves latency for long system
   * prompts with little first-token cost.
   */
  cachePrompt?: boolean;
}

/**
 * Decode parameters shared by chat and completion requests (ticket #120).
 * Each provider maps these onto its native body field names.
 */
export interface DecodeParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stop?: string[];
}

/** Task class used to pick the default decode profile (ticket #120). */
export type TaskHint =
  | "coding"
  | "chat"
  | "completion"
  | "toolcall"
  | "embedding";

/**
 * Runtime options for a single chat request.
 */
export interface ChatOptions {
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stop?: string[];
  /** Task class for picking the default decode profile (ticket #120). */
  taskHint?: TaskHint;
  /** When true, instruct the provider to output valid JSON only. Supported by Ollama and some OpenAI-compatible providers. */
  jsonFormat?: boolean;
}

/**
 * Runtime options for a single completion (FIM) request.
 */
export interface CompleteOptions {
  abortSignal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
  /** Task class for picking the default decode profile (ticket #120). */
  taskHint?: TaskHint;
}

/**
 * Unified interface for all LLM providers. Implementations live in this
 * directory (one file per provider).
 */
export interface LLMProvider {
  readonly name: string;
  readonly config: LLMProviderConfig;

  /**
   * Stream a chat-style request with message history.
   */
  chat(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): AsyncIterable<StreamDelta>;

  /**
   * Stream a completion-style request (single prompt, no history). Used for
   * inline autocomplete.
   */
  complete(
    prompt: string,
    options?: CompleteOptions,
  ): AsyncIterable<StreamDelta>;

  /** Whether this provider natively supports tool_use. */
  supportsToolUse(): boolean;

  /** Whether this provider supports streaming. */
  supportsStreaming(): boolean;

  /** Count tokens for the given text using the provider's tokenizer. */
  countTokens(text: string): number;

  /** Return metadata about the currently configured model. */
  modelInfo(): ModelInfo;

  /** Dispose of any held resources (HTTP connections, etc.). */
  dispose(): void;

  /**
   * Return a copy of this provider configured to use a different model.
   * Used by SmartRouter to route a request to a specific discovered model
   * without mutating the shared provider instance.
   */
  withModel(modelId: string): LLMProvider;
}
