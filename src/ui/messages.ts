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
import type { SessionMetadata } from "../agent-manager/types";
import type { McpMarketplaceEntry } from "../marketplace/mcp-marketplace-client";
import type { TeamRunState } from "../agent/team-definition";

// ---------------------------------------------------------------------------
// Runtime message guard
// ---------------------------------------------------------------------------

/** Runtime guard — validates the bare minimum before dispatching in message handlers */
export function isValidMessage(data: unknown): data is { type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof (data as Record<string, unknown>)["type"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Extension Host -> Webview
// ---------------------------------------------------------------------------

export interface StreamDeltaMessage {
  type: "streamDelta";
  text: string;
}

/** Sent before a multi-agent workflow to put the UI into streaming mode. */
export interface StreamStartMessage {
  type: "streamStart";
  /** Optional user request text shown as a user bubble. */
  userText?: string;
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
  preview?: {
    type: "diff" | "command";
    content: string;
    label?: string;
  };
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface PiiNoticeMessage {
  type: "piiNotice";
  /** e.g. "2 value(s) redacted before sending (email, phone)" */
  summary: string;
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
  /**
   * One-line example of what the skill produces, shown as a third
   * row in the slash-command autocomplete dropdown.
   * e.g. "Outputs: 3 issues found in src/auth.ts"
   */
  example?: string;
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
  /**
   * When set, the model cannot be used yet. Value is a short human-readable
   * reason shown in the picker (e.g. "API key not set"). The model is still
   * shown in the list but rendered greyed-out with a click-to-fix action.
   */
  unavailable?: string;
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

/**
 * Full session list sent to the webview on activation and after every
 * session change (create/switch/delete/rename).
 */
export interface SessionListMessage {
  type: "sessionList";
  sessions: SessionMetadata[];
  activeSessionId: string | null;
}

/**
 * Observability metrics snapshot sent to the webview for the
 * status footer and expandable metrics panel.
 */
export interface MetricsUpdateMessage {
  type: "metricsUpdate";
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  averageLatency: number;
  totalFailures: number;
}

/**
 * Sent after each streamEnd to let the webview display per-session
 * token usage and an estimated cost in the footer counter.
 * Tokens are cumulative for the current session (reset on newChat).
 */
export interface SessionTokenUsageMessage {
  type: "sessionTokenUsage";
  /** Total input tokens consumed by this session so far. */
  sessionInputTokens: number;
  /** Total output tokens generated by this session so far. */
  sessionOutputTokens: number;
  /**
   * Rough cost estimate in USD based on a fixed rate table.
   * 0 when the active provider has no pricing data (e.g. local Ollama).
   */
  estimatedCostUsd: number;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  /** Number of resources exposed by this server (0 if server doesn't support resources). */
  resourceCount: number;
  /** Number of prompt templates exposed by this server (0 if server doesn't support prompts). */
  promptCount: number;
  error?: string;
}

export interface McpStatusMessage {
  type: "mcpStatus";
  servers: McpServerStatus[];
}

export interface McpAnalyticsMessage {
  type: "mcpAnalytics";
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  byTool: Record<
    string,
    { calls: number; successRate: number; avgLatencyMs: number }
  >;
}

export interface WorkflowHistoryRun {
  id: string;
  name: string;
  status: "running" | "awaiting-approval" | "completed" | "failed" | "stopped";
  mode: "auto" | "safe" | "audit";
  startTime: number;
  endTime?: number;
  stepCount: number;
  filesChanged: number;
  progress?: { current: number; total: number };
}

export interface WorkflowHistoryUpdateMessage {
  type: "workflowHistoryUpdate";
  runs: WorkflowHistoryRun[];
}

export interface FileEditDiffMessage {
  type: "fileEditDiff";
  path: string;
  oldContent: string;
  newContent: string;
}

export interface EditSummaryMessage {
  type: "editSummary";
  edits: Array<{ path: string; oldContent: string; newContent: string }>;
}

export interface AutoContextNoticeMessage {
  type: "autoContextNotice";
  files: string[];
}

export interface McpMarketplaceOpenMessage {
  type: "mcpMarketplaceOpen";
}

export interface McpMarketplaceEntriesMessage {
  type: "mcpMarketplaceEntries";
  entries: McpMarketplaceEntry[];
}

export interface McpMarketplaceInstallCompleteMessage {
  type: "mcpMarketplaceInstallComplete";
  name: string;
  success: boolean;
  errorMessage?: string;
}

export interface TeamRunSnapshotMessage {
  type: "teamRunSnapshot";
  state: TeamRunState;
}

// ---------------------------------------------------------------------------
// Team Builder — Extension Host -> Webview
// ---------------------------------------------------------------------------

/** Sent when champ.openTeamBuilder opens; passes the definition to display. */
export interface TeamBuilderLoadMessage {
  type: "teamBuilderLoad";
  /** Serialized TeamDefinition JSON, or null when opening a blank canvas. */
  team: import("../agent/team-definition").TeamDefinition | null;
  /** All available team names already on disk (for overwrite detection). */
  existingNames: string[];
}

/** Sent after a successful save to notify the webview. */
export interface TeamBuilderSaveAckMessage {
  type: "teamBuilderSaveAck";
  savedPath: string;
}

/** Sent when champ.openRulesEditor opens. */
export interface RulesListMessage {
  type: "rulesList";
  rules: Array<{
    name: string;
    content: string;
    type: "always" | "auto-attached" | "agent-requested";
    glob?: string;
  }>;
}

/** Sent after a successful rule save or delete. */
export interface RulesListAckMessage {
  type: "rulesListAck";
  rules: Array<{
    name: string;
    content: string;
    type: "always" | "auto-attached" | "agent-requested";
    glob?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Team Builder — Webview -> Extension Host
// ---------------------------------------------------------------------------

/** The user clicked Save in the team builder. */
export interface TeamBuilderSaveRequest {
  type: "teamBuilderSave";
  team: {
    name: string;
    description: string;
    version: string;
    agents: Array<{
      id: string;
      name: string;
      role: string;
      systemPrompt: string;
      dependsOn: string[];
      condition: string;
      tools: string[];
      model: string;
      maxTokens: number;
      outputKey: string;
      outputFormat: "text" | "json" | "files";
      selfCritique: boolean;
      subscribes: string[];
    }>;
    defaults: { model?: string; maxTokens?: number; temperature?: number };
    execution: {
      maxParallel: number;
      totalTokenBudget: number;
      timeoutSeconds: number;
      retries: number;
      checkpoints: boolean;
      mode: "auto" | "safe" | "supervised";
    };
  };
}

/** The user clicked "Add Rule" or "Save Rule" in the rules editor. */
export interface RuleAddRequest {
  type: "ruleAdd";
  rule: {
    name: string;
    content: string;
    type: "always" | "auto-attached" | "agent-requested";
    glob?: string;
  };
}

/** The user clicked "Delete" on a rule. */
export interface RuleDeleteRequest {
  type: "ruleDelete";
  name: string;
}

// ---- Memory messages ----

export interface MemoryItem {
  id: string;
  timestamp: number;
  userQuery: string;
  assistantSummary: string;
  sessionId: string;
  pinned?: boolean;
}

/** Sent to webview to update the memory badge count in the chat header. */
export interface MemoryBadgeMessage {
  type: "memoryBadge";
  count: number;
}

/** Sent to webview when memory panel requests the full list. */
export interface MemoryListMessage {
  type: "memoryList";
  items: MemoryItem[];
}

// Webview → Extension

export interface OpenMemoryBankRequest {
  type: "openMemoryBank";
}

export interface MemoryDeleteRequest {
  type: "memoryDelete";
  id: string;
}

export interface MemoryPinRequest {
  type: "memoryPin";
  id: string;
  pinned: boolean;
}

export interface MemoryAddRequest {
  type: "memoryAdd";
  text: string;
}

// Team execution control messages

/** Extension → Webview: pre-run cost estimate before a team run starts. */
export interface TeamCostEstimateMessage {
  type: "teamCostEstimate";
  agentCount: number;
  estimatedTokens: number;
  /** Formatted e.g. "~$0.04" or "< $0.01". */
  estimatedCostUsd: string;
  teamName: string;
}

/** Webview → Extension: user clicked "Pause" in TeamPanel. */
export interface TeamPauseRequest {
  type: "teamPause";
}

/** Webview → Extension: user clicked "Resume" in TeamPanel after a pause. */
export interface TeamResumeRequest {
  type: "teamResume";
}

/** Webview → Extension: re-run a previous team execution with the same task. */
export interface RerunTeamRequest {
  type: "rerunTeam";
  runId: string;
}

/**
 * Streamed terminal output chunk sent from the extension host to the
 * webview as run_terminal_cmd executes. One message per stdout chunk.
 * A final message with done=true marks the end of the execution.
 */
export interface TerminalOutputChunkMessage {
  type: "terminalOutputChunk";
  /** Unique identifier for this execution run, matches RunInTerminalRequest.executionId. */
  executionId: string;
  /** Partial stdout text (may be empty on the done=true sentinel). */
  chunk: string;
  /** True on the final message; the webview should close the streaming block. */
  done: boolean;
}

export type ExtensionToWebviewMessage =
  | StreamStartMessage
  | StreamDeltaMessage
  | StreamEndMessage
  | ToolCallStartMessage
  | ToolCallResultMessage
  | ApprovalRequestMessage
  | ErrorMessage
  | PiiNoticeMessage
  | ModeChangedMessage
  | ConversationHistoryMessage
  | ReadyMessage
  | SkillAutocompleteResponseMessage
  | ProviderStatusMessage
  | FirstRunWelcomeMessage
  | SessionListMessage
  | MetricsUpdateMessage
  | SessionTokenUsageMessage
  | McpStatusMessage
  | McpAnalyticsMessage
  | WorkflowHistoryUpdateMessage
  | FileEditDiffMessage
  | EditSummaryMessage
  | AutoContextNoticeMessage
  | McpMarketplaceOpenMessage
  | McpMarketplaceEntriesMessage
  | McpMarketplaceInstallCompleteMessage
  | TeamRunSnapshotMessage
  | TeamBuilderLoadMessage
  | TeamBuilderSaveAckMessage
  | RulesListMessage
  | RulesListAckMessage
  | MemoryBadgeMessage
  | MemoryListMessage
  | TeamCostEstimateMessage
  | TerminalOutputChunkMessage;

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
 * VS Code's settings UI filtered to `champ.*`.
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
  /** The specific model ID the user selected (e.g. "llama3.1:8b"). */
  modelName?: string;
}

/**
 * The user picked a starter config template from the onboarding panel.
 * The host writes the template YAML to .champ/config.yaml.
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

/**
 * The user clicked the attach button. The webview can't use native
 * file inputs (CSP blocks them), so it asks the host to open VS Code's
 * file picker dialog.
 */
export interface OpenFilePickerRequest {
  type: "openFilePickerRequest";
}

/**
 * The user attached a file via the paperclip button. The webview reads
 * the file with FileReader and sends the base64 content to the host.
 * The host decodes it and stores it in pending attachments until the
 * next user message is sent.
 */
export interface AttachFileRequest {
  type: "attachFileRequest";
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface SwitchSessionRequest {
  type: "switchSessionRequest";
  sessionId: string;
}

export interface NewSessionRequest {
  type: "newSessionRequest";
  label?: string;
}

export interface DeleteSessionRequest {
  type: "deleteSessionRequest";
  sessionId: string;
}

export interface RenameSessionRequest {
  type: "renameSessionRequest";
  sessionId: string;
  newLabel: string;
}

/**
 * User clicked a generated file link in the chat. The host opens the
 * file in an editor tab and opens a side-by-side Markdown preview.
 */
export interface OpenGeneratedFileRequest {
  type: "openGeneratedFileRequest";
  /** Absolute path to the file to open. */
  filePath: string;
}

export interface ReloadMcpServerRequest {
  type: "reloadMcpServer";
  serverName: string;
}

export interface McpConfigSaveRequest {
  type: "mcpConfigSave";
  server: {
    name: string;
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  };
  action: "add" | "delete";
}

/** The ⚡ multi-agent button was clicked in the webview action bar. */
export interface RunMultiAgentRequest {
  type: "runMultiAgent";
}

export interface RunTeamRequest {
  type: "runTeam";
}

export interface OpenWorkflowRunRequest {
  type: "openWorkflowRun";
  runId: string;
}

export interface RerunWorkflowRequest {
  type: "rerunWorkflow";
  runId: string;
}

export interface SetYoloModeRequest {
  type: "setYoloMode";
  enabled: boolean;
}

export interface SetAutocompleteRequest {
  type: "setAutocomplete";
  enabled: boolean;
}

export interface OpenConfigFileRequest {
  type: "openConfigFile";
}

export interface RescanModelsRequest {
  type: "rescanModels";
}

export interface ResetToAutoRequest {
  type: "resetToAutoRequest";
}

export interface RevertEditRequest {
  type: "revertEdit";
  path: string;
  restoreContent: string;
}

export interface AcceptAllEditsRequest {
  type: "acceptAllEdits";
}

export interface RevertAllEditsRequest {
  type: "revertAllEdits";
  edits: Array<{ path: string; restoreContent: string }>;
}

export interface FetchMcpMarketplaceRequest {
  type: "fetchMcpMarketplace";
}

export interface McpMarketplaceInstallRequest {
  type: "mcpMarketplaceInstall";
  entry: McpMarketplaceEntry;
}

export interface AcceptHunkAtLineRequest {
  type: "acceptHunkAtLine";
  filePath: string;
  line: number;
}

export interface RejectHunkAtLineRequest {
  type: "rejectHunkAtLine";
  filePath: string;
  line: number;
}

export interface FocusTeamAgentRequest {
  type: "focusTeamAgent";
  agentId: string;
}

/**
 * The user edited a previous user message and wants to re-run from that
 * point. The host truncates the conversation history back to just before
 * `originalText` and resubmits `newText` as a fresh user turn.
 */
export interface EditUserMessageRequest {
  type: "editUserMessage";
  /** The original message text (used to find the turn to truncate from). */
  originalText: string;
  /** The replacement text the user typed. */
  newText: string;
}

/**
 * The user clicked the "Run" button on a bash code block in the chat.
 * The host runs the command via run_terminal_cmd and streams output back
 * as TerminalOutputChunkMessage.
 */
export interface RunInTerminalRequest {
  type: "runInTerminal";
  /** The shell command extracted from the fenced code block. */
  command: string;
  /** Webview-generated identifier so the host can correlate streaming chunks. */
  executionId: string;
}

/**
 * The user clicked the "↺ Regenerate" button below the last assistant
 * response. The host should truncate the last assistant turn and re-run
 * the last user message.
 */
export interface RegenerateResponseRequest {
  type: "regenerateResponse";
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
  | FirstRunDismissRequest
  | AttachFileRequest
  | OpenFilePickerRequest
  | SwitchSessionRequest
  | NewSessionRequest
  | DeleteSessionRequest
  | RenameSessionRequest
  | OpenGeneratedFileRequest
  | ReloadMcpServerRequest
  | McpConfigSaveRequest
  | RunMultiAgentRequest
  | RunTeamRequest
  | SetYoloModeRequest
  | SetAutocompleteRequest
  | OpenConfigFileRequest
  | RescanModelsRequest
  | ResetToAutoRequest
  | OpenWorkflowRunRequest
  | RerunWorkflowRequest
  | RevertEditRequest
  | AcceptAllEditsRequest
  | RevertAllEditsRequest
  | FetchMcpMarketplaceRequest
  | McpMarketplaceInstallRequest
  | AcceptHunkAtLineRequest
  | RejectHunkAtLineRequest
  | FocusTeamAgentRequest
  | TeamBuilderSaveRequest
  | RuleAddRequest
  | RuleDeleteRequest
  | OpenMemoryBankRequest
  | MemoryDeleteRequest
  | MemoryPinRequest
  | MemoryAddRequest
  | TeamPauseRequest
  | TeamResumeRequest
  | RerunTeamRequest
  | EditUserMessageRequest
  | RunInTerminalRequest
  | RegenerateResponseRequest
  | SaveSettingsRequest
  | CopyToClipboardRequest;

export interface CopyToClipboardRequest {
  type: "copyToClipboard";
  text: string;
}
export function isCopyToClipboardRequest(
  msg: WebviewToExtensionMessage,
): msg is CopyToClipboardRequest {
  return msg.type === "copyToClipboard";
}

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

export function createPiiNotice(summary: string): PiiNoticeMessage {
  return { type: "piiNotice", summary };
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

export function createSessionList(
  sessions: SessionMetadata[],
  activeSessionId: string | null,
): SessionListMessage {
  return { type: "sessionList", sessions, activeSessionId };
}

export function createSessionTokenUsage(
  sessionInputTokens: number,
  sessionOutputTokens: number,
  estimatedCostUsd = 0,
): SessionTokenUsageMessage {
  return {
    type: "sessionTokenUsage",
    sessionInputTokens,
    sessionOutputTokens,
    estimatedCostUsd,
  };
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

export function isAttachFileRequest(
  msg: WebviewToExtensionMessage,
): msg is AttachFileRequest {
  return msg.type === "attachFileRequest";
}

export function isOpenFilePickerRequest(
  msg: WebviewToExtensionMessage,
): msg is OpenFilePickerRequest {
  return msg.type === "openFilePickerRequest";
}

export function isSwitchSessionRequest(
  msg: WebviewToExtensionMessage,
): msg is SwitchSessionRequest {
  return msg.type === "switchSessionRequest";
}

export function isNewSessionRequest(
  msg: WebviewToExtensionMessage,
): msg is NewSessionRequest {
  return msg.type === "newSessionRequest";
}

export function isDeleteSessionRequest(
  msg: WebviewToExtensionMessage,
): msg is DeleteSessionRequest {
  return msg.type === "deleteSessionRequest";
}

export function isRenameSessionRequest(
  msg: WebviewToExtensionMessage,
): msg is RenameSessionRequest {
  return msg.type === "renameSessionRequest";
}

export function isOpenGeneratedFileRequest(
  msg: WebviewToExtensionMessage,
): msg is OpenGeneratedFileRequest {
  return msg.type === "openGeneratedFileRequest";
}

export function isReloadMcpServerRequest(
  msg: WebviewToExtensionMessage,
): msg is ReloadMcpServerRequest {
  return msg.type === "reloadMcpServer";
}

export function isMcpConfigSaveRequest(
  msg: WebviewToExtensionMessage,
): msg is McpConfigSaveRequest {
  return msg.type === "mcpConfigSave";
}

export function isRevertEditRequest(
  msg: WebviewToExtensionMessage,
): msg is RevertEditRequest {
  return msg.type === "revertEdit";
}

export function isAcceptAllEditsRequest(
  msg: WebviewToExtensionMessage,
): msg is AcceptAllEditsRequest {
  return msg.type === "acceptAllEdits";
}

export function isRevertAllEditsRequest(
  msg: WebviewToExtensionMessage,
): msg is RevertAllEditsRequest {
  return msg.type === "revertAllEdits";
}

// ── Additional runtime type guards ─────────────────────────────────────────
// For message types handled via raw casts in chat-view-provider.ts

export function isSetYoloModeRequest(
  msg: WebviewToExtensionMessage,
): msg is SetYoloModeRequest {
  return msg.type === "setYoloMode";
}

export function isSetAutocompleteRequest(
  msg: WebviewToExtensionMessage,
): msg is SetAutocompleteRequest {
  return msg.type === "setAutocomplete";
}

export function isOpenWorkflowRunRequest(
  msg: WebviewToExtensionMessage,
): msg is OpenWorkflowRunRequest {
  return msg.type === "openWorkflowRun";
}

export function isRerunWorkflowRequest(
  msg: WebviewToExtensionMessage,
): msg is RerunWorkflowRequest {
  return msg.type === "rerunWorkflow";
}

export function isRunMultiAgentRequest(
  msg: WebviewToExtensionMessage,
): msg is RunMultiAgentRequest {
  return msg.type === "runMultiAgent";
}

export function isRunTeamRequest(
  msg: WebviewToExtensionMessage,
): msg is RunTeamRequest {
  return msg.type === "runTeam";
}

export function isOpenConfigFileRequest(
  msg: WebviewToExtensionMessage,
): msg is OpenConfigFileRequest {
  return msg.type === "openConfigFile";
}

export function isRescanModelsRequest(
  msg: WebviewToExtensionMessage,
): msg is RescanModelsRequest {
  return msg.type === "rescanModels";
}

export function isResetToAutoRequest(
  msg: WebviewToExtensionMessage,
): msg is ResetToAutoRequest {
  return msg.type === "resetToAutoRequest";
}

export function isFetchMcpMarketplaceRequest(
  msg: WebviewToExtensionMessage,
): msg is FetchMcpMarketplaceRequest {
  return msg.type === "fetchMcpMarketplace";
}

export function isMcpMarketplaceInstallRequest(
  msg: WebviewToExtensionMessage,
): msg is McpMarketplaceInstallRequest {
  return msg.type === "mcpMarketplaceInstall";
}

export function isAcceptHunkAtLineRequest(
  msg: WebviewToExtensionMessage,
): msg is AcceptHunkAtLineRequest {
  return msg.type === "acceptHunkAtLine";
}

export function isRejectHunkAtLineRequest(
  msg: WebviewToExtensionMessage,
): msg is RejectHunkAtLineRequest {
  return msg.type === "rejectHunkAtLine";
}

export function isFocusTeamAgentRequest(
  msg: WebviewToExtensionMessage,
): msg is FocusTeamAgentRequest {
  return msg.type === "focusTeamAgent";
}

export function isOpenMemoryBankRequest(
  msg: WebviewToExtensionMessage,
): msg is OpenMemoryBankRequest {
  return msg.type === "openMemoryBank";
}

export function isMemoryDeleteRequest(
  msg: WebviewToExtensionMessage,
): msg is MemoryDeleteRequest {
  return msg.type === "memoryDelete";
}

export function isMemoryPinRequest(
  msg: WebviewToExtensionMessage,
): msg is MemoryPinRequest {
  return msg.type === "memoryPin";
}

export function isMemoryAddRequest(
  msg: WebviewToExtensionMessage,
): msg is MemoryAddRequest {
  return msg.type === "memoryAdd";
}

export function isTeamPauseRequest(
  msg: WebviewToExtensionMessage,
): msg is TeamPauseRequest {
  return msg.type === "teamPause";
}

export function isTeamResumeRequest(
  msg: WebviewToExtensionMessage,
): msg is TeamResumeRequest {
  return msg.type === "teamResume";
}

export function isRerunTeamRequest(
  msg: WebviewToExtensionMessage,
): msg is RerunTeamRequest {
  return msg.type === "rerunTeam";
}

export function isSessionTokenUsageMessage(
  msg: WebviewToExtensionMessage | ExtensionToWebviewMessage,
): msg is SessionTokenUsageMessage {
  return (msg as SessionTokenUsageMessage).type === "sessionTokenUsage";
}

export function isEditUserMessage(
  msg: WebviewToExtensionMessage,
): msg is EditUserMessageRequest {
  return msg.type === "editUserMessage";
}

// Factory helper
export function createTerminalOutputChunk(
  executionId: string,
  chunk: string,
  done: boolean,
): TerminalOutputChunkMessage {
  return { type: "terminalOutputChunk", executionId, chunk, done };
}

// Type guards
export function isTerminalOutputChunkMessage(
  msg: ExtensionToWebviewMessage,
): msg is TerminalOutputChunkMessage {
  return msg.type === "terminalOutputChunk";
}

export function isRunInTerminalRequest(
  msg: WebviewToExtensionMessage,
): msg is RunInTerminalRequest {
  return msg.type === "runInTerminal";
}

export function isTeamBuilderSaveRequest(
  msg: WebviewToExtensionMessage,
): msg is TeamBuilderSaveRequest {
  return msg.type === "teamBuilderSave";
}

export function isRuleAddRequest(
  msg: WebviewToExtensionMessage,
): msg is RuleAddRequest {
  return msg.type === "ruleAdd";
}

export function isRuleDeleteRequest(
  msg: WebviewToExtensionMessage,
): msg is RuleDeleteRequest {
  return msg.type === "ruleDelete";
}

export function isRegenerateResponseRequest(
  msg: WebviewToExtensionMessage,
): msg is RegenerateResponseRequest {
  return msg.type === "regenerateResponse";
}

/**
 * The user clicked "Save & Reload" in the in-webview settings overlay.
 * The host updates champ.provider and champ.<provider>.model in global
 * VS Code settings then reloads the active provider.
 */
export interface SaveSettingsRequest {
  type: "saveSettings";
  provider: string;
  model: string;
}

export function isSaveSettingsRequest(
  msg: WebviewToExtensionMessage,
): msg is SaveSettingsRequest {
  return msg.type === "saveSettings";
}
