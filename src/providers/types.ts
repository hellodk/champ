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
  | { type: "tool_call_end"; toolCallId?: string }
  | { type: "done"; usage: TokenUsage }
  | { type: "error"; error: string };

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
}

/**
 * Runtime options for a single chat request.
 */
export interface ChatOptions {
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * Runtime options for a single completion (FIM) request.
 */
export interface CompleteOptions {
  abortSignal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
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
}
