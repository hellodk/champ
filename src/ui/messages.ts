/**
 * Webview message protocol.
 *
 * All communication between the extension host and the chat webview
 * flows through two discriminated unions: one for each direction. Type
 * guards let the webview and host agree on message shape without
 * importing each other's code.
 */
import type { AgentMode } from "../prompts/system-prompt";
import type { LLMMessage } from "../providers/types";

// ---------------------------------------------------------------------------
// Extension Host -> Webview
// ---------------------------------------------------------------------------

export interface StreamDeltaMessage {
  type: "streamDelta";
  text: string;
}

export interface StreamEndMessage {
  type: "streamEnd";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ToolCallStartMessage {
  type: "toolCallStart";
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCallResultMessage {
  type: "toolCallResult";
  toolName: string;
  result: string;
  success: boolean;
}

export interface ApprovalRequestMessage {
  type: "approvalRequest";
  id: string;
  description: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface ModeChangedMessage {
  type: "modeChanged";
  mode: AgentMode;
}

export interface ConversationHistoryMessage {
  type: "conversationHistory";
  messages: LLMMessage[];
}

export interface ReadyMessage {
  type: "ready";
  availableModes: AgentMode[];
  currentMode: AgentMode;
  modelName: string;
}

export type ExtensionToWebviewMessage =
  | StreamDeltaMessage
  | StreamEndMessage
  | ToolCallStartMessage
  | ToolCallResultMessage
  | ApprovalRequestMessage
  | ErrorMessage
  | ModeChangedMessage
  | ConversationHistoryMessage
  | ReadyMessage;

// ---------------------------------------------------------------------------
// Webview -> Extension Host
// ---------------------------------------------------------------------------

export interface UserMessageRequest {
  type: "userMessage";
  text: string;
}

export interface SetModeRequest {
  type: "setMode";
  mode: AgentMode;
}

export interface NewChatRequest {
  type: "newChat";
}

export interface CancelRequest {
  type: "cancelRequest";
}

export interface ApprovalResponseRequest {
  type: "approvalResponse";
  id: string;
  approved: boolean;
}

export interface RequestHistoryRequest {
  type: "requestHistory";
}

export type WebviewToExtensionMessage =
  | UserMessageRequest
  | SetModeRequest
  | NewChatRequest
  | CancelRequest
  | ApprovalResponseRequest
  | RequestHistoryRequest;

// ---------------------------------------------------------------------------
// Factory helpers (Extension -> Webview)
// ---------------------------------------------------------------------------

export function createStreamDelta(text: string): StreamDeltaMessage {
  return { type: "streamDelta", text };
}

export function createStreamEnd(usage?: {
  inputTokens: number;
  outputTokens: number;
}): StreamEndMessage {
  return { type: "streamEnd", usage };
}

export function createToolCallStart(
  toolName: string,
  args: Record<string, unknown>,
): ToolCallStartMessage {
  return { type: "toolCallStart", toolName, args };
}

export function createToolCallResult(
  toolName: string,
  result: string,
  success: boolean,
): ToolCallResultMessage {
  return { type: "toolCallResult", toolName, result, success };
}

export function createError(message: string): ErrorMessage {
  return { type: "error", message };
}

export function createConversationHistory(
  messages: LLMMessage[],
): ConversationHistoryMessage {
  return { type: "conversationHistory", messages };
}

// ---------------------------------------------------------------------------
// Type guards (Webview -> Extension)
// ---------------------------------------------------------------------------

export function isUserMessage(
  msg: WebviewToExtensionMessage,
): msg is UserMessageRequest {
  return msg.type === "userMessage";
}

export function isSetMode(
  msg: WebviewToExtensionMessage,
): msg is SetModeRequest {
  return msg.type === "setMode";
}

export function isNewChat(
  msg: WebviewToExtensionMessage,
): msg is NewChatRequest {
  return msg.type === "newChat";
}

export function isCancelRequest(
  msg: WebviewToExtensionMessage,
): msg is CancelRequest {
  return msg.type === "cancelRequest";
}

export function isApprovalResponse(
  msg: WebviewToExtensionMessage,
): msg is ApprovalResponseRequest {
  return msg.type === "approvalResponse";
}

export function isRequestHistory(
  msg: WebviewToExtensionMessage,
): msg is RequestHistoryRequest {
  return msg.type === "requestHistory";
}
