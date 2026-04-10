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

/**
 * Skill suggestion entry sent to the webview for the slash-command
 * autocomplete dropdown. Kept minimal — just enough to render the
 * dropdown row.
 */
export interface SkillSuggestion {
  name: string;
  description: string;
}

export interface SkillAutocompleteResponseMessage {
  type: "skillAutocompleteResponse";
  /** The prefix the suggestions were generated for, so the webview
   *  can ignore stale responses if the user has typed more since. */
  prefix: string;
  suggestions: SkillSuggestion[];
}

/**
 * Provider lifecycle state — used to drive the chat header indicator
 * and the model dropdown in the bottom bar. The extension broadcasts
 * a ProviderStatus on every loadProvider() call so the webview always
 * has the latest active provider info.
 */
export type ProviderStatusState = "loading" | "ready" | "error";

/**
 * One entry in the model dropdown. Built from the configured
 * providers in the YAML config — the user can pick any of these to
 * switch the active provider.
 */
export interface AvailableProviderModel {
  providerName: string;
  modelName: string;
  /** Pre-formatted user-facing label, e.g. "ollama: qwen2.5-coder:14b". */
  label: string;
}

export interface ProviderStatusMessage {
  type: "providerStatus";
  state: ProviderStatusState;
  /** Active provider name when state === "ready". */
  providerName?: string;
  /** Active model name when state === "ready". */
  modelName?: string;
  /** Error message when state === "error". */
  errorMessage?: string;
  /** Every provider+model combination defined in the YAML config. */
  available: AvailableProviderModel[];
}

/**
 * Onboarding template entry sent to the webview so the user can
 * pick a starter configuration.
 */
export interface FirstRunTemplate {
  id: string;
  label: string;
  description: string;
}

export interface FirstRunWelcomeMessage {
  type: "firstRunWelcome";
  templates: FirstRunTemplate[];
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
  | ReadyMessage
  | SkillAutocompleteResponseMessage
  | ProviderStatusMessage
  | FirstRunWelcomeMessage;

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

export interface SkillAutocompleteRequest {
  type: "skillAutocompleteRequest";
  /** Text after the leading slash, e.g. "ex" for "/ex". */
  prefix: string;
}

/**
 * The settings gear in the chat header was clicked. The host opens
 * VS Code's settings UI filtered to `aidev.*`.
 */
export interface OpenSettingsRequest {
  type: "openSettingsRequest";
}

/**
 * The help button in the chat header was clicked. The host opens
 * docs/USER_GUIDE.md as an editor tab.
 */
export interface ShowHelpRequest {
  type: "showHelpRequest";
}

/**
 * The user picked a different provider from the model dropdown in the
 * bottom bar. The host rewrites the active YAML config's `provider:`
 * line and the file watcher reloads the agent.
 */
export interface SetModelRequest {
  type: "setModelRequest";
  providerName: string;
}

/**
 * The user picked a starter config template from the onboarding panel.
 * The host writes the template YAML to .aidev/config.yaml.
 */
export interface FirstRunSelectRequest {
  type: "firstRunSelectRequest";
  templateId: string;
}

/**
 * The user dismissed the onboarding panel without picking a template.
 * The host sets a globalState flag so it doesn't reappear.
 */
export interface FirstRunDismissRequest {
  type: "firstRunDismissRequest";
}

export type WebviewToExtensionMessage =
  | UserMessageRequest
  | SetModeRequest
  | NewChatRequest
  | CancelRequest
  | ApprovalResponseRequest
  | RequestHistoryRequest
  | SkillAutocompleteRequest
  | OpenSettingsRequest
  | ShowHelpRequest
  | SetModelRequest
  | FirstRunSelectRequest
  | FirstRunDismissRequest;

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

export function createSkillAutocompleteResponse(
  suggestions: SkillSuggestion[],
  prefix = "",
): SkillAutocompleteResponseMessage {
  return { type: "skillAutocompleteResponse", prefix, suggestions };
}

/**
 * Build a providerStatus message. The single options object lets the
 * caller pass only the fields relevant to the current state — for
 * loading and error states, providerName/modelName can be omitted.
 */
export function createProviderStatus(opts: {
  state: ProviderStatusState;
  providerName?: string;
  modelName?: string;
  errorMessage?: string;
  available: AvailableProviderModel[];
}): ProviderStatusMessage {
  return {
    type: "providerStatus",
    state: opts.state,
    providerName: opts.providerName,
    modelName: opts.modelName,
    errorMessage: opts.errorMessage,
    available: opts.available,
  };
}

export function createFirstRunWelcome(
  templates: FirstRunTemplate[],
): FirstRunWelcomeMessage {
  return { type: "firstRunWelcome", templates };
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

export function isSkillAutocompleteRequest(
  msg: WebviewToExtensionMessage,
): msg is SkillAutocompleteRequest {
  return msg.type === "skillAutocompleteRequest";
}

export function isOpenSettingsRequest(
  msg: WebviewToExtensionMessage,
): msg is OpenSettingsRequest {
  return msg.type === "openSettingsRequest";
}

export function isShowHelpRequest(
  msg: WebviewToExtensionMessage,
): msg is ShowHelpRequest {
  return msg.type === "showHelpRequest";
}

export function isSetModelRequest(
  msg: WebviewToExtensionMessage,
): msg is SetModelRequest {
  return msg.type === "setModelRequest";
}

export function isFirstRunSelectRequest(
  msg: WebviewToExtensionMessage,
): msg is FirstRunSelectRequest {
  return msg.type === "firstRunSelectRequest";
}

export function isFirstRunDismissRequest(
  msg: WebviewToExtensionMessage,
): msg is FirstRunDismissRequest {
  return msg.type === "firstRunDismissRequest";
}
