/**
 * Boundary between the Ink UI and the headless Champ runtime.
 *
 * The TUI never imports the CLI entry point. The CLI builds the agent once and
 * hands this adapter across, so both frontends share providers, tools, rules,
 * sessions, policies and turn execution.
 */
import type { CommandSuggestion } from "../cli/commands";
import type { TuiSelection } from "./endpoints";
import type { ContextSnapshot, UsageRecord } from "./insights";
import type { McpServerStatus } from "./mcp";
import type { PlanStepInput } from "./plan";
import type { RecoverySnapshot } from "./recovery";
import type { ThemeName } from "./theme";
import type { ChatRole, EndpointSummary, TuiScreen } from "./state";
import type { ToolResultEvent, ToolStartEvent } from "./tool-events";

export interface TuiHeader {
  version: string;
  model: string;
  workspace: string;
  sessionId?: string;
  routingMode?: string;
}

export interface TuiTurnSummary {
  tools: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  toolDurationMs?: number;
  firstTokenMs?: number;
  model?: string;
  provider?: string;
  costUsd?: number | null;
  costKnown?: boolean;
  pricingVersion?: string;
  contextUsed?: number;
  contextWindow?: number;
  contextRemaining?: number;
  contextPercent?: number;
  retries?: number;
  fallbacks?: number;
  compactions?: number;
}

export interface TuiTurnEvents {
  onText?: (chunk: string) => void;
  onTool?: (name: string, args: string) => void;
  onToolResult?: (name: string, output: string, success: boolean) => void;
  onError?: (message: string) => void;
  onDone?: (summary: TuiTurnSummary) => void;
  /** Structured events retain what the summary callbacks discard. */
  onToolEvent?: (event: ToolStartEvent) => void;
  onToolResultEvent?: (event: ToolResultEvent) => void;
  onPlan?: (steps: PlanStepInput[]) => void;
  onUsage?: (record: UsageRecord) => void;
  onContext?: (snapshot: ContextSnapshot) => void;
}

export interface TuiTurnResult {
  text: string;
  error?: string;
  aborted: boolean;
}

export interface TuiResumedSession {
  summary: string;
  messages: Array<{ role: ChatRole; text: string }>;
}

export interface TuiAddEndpointInput {
  name: string;
  provider: string;
  baseUrl?: string;
  credentialId?: string;
  apiKey?: string;
  model?: string;
}

export interface TuiDoctorReport {
  healthy: boolean;
  lines: string[];
}

export interface TuiSessionSummary {
  id: string;
  label: string;
  updatedAt: string;
  preview?: string;
}

export interface TuiReviewSummary {
  id: string;
  status: string;
  files: number;
  summary: string;
}

export interface TuiConfigEntry {
  key: string;
  value: string;
  description: string;
}

export interface TuiRuntime {
  header: TuiHeader;
  initialEndpoints: EndpointSummary[];
  /** Endpoint/model resolved from the registry assignment before rendering. */
  initialSelection?: TuiSelection;
  initialScreen?: TuiScreen;
  /** Palette forced by `--theme`; otherwise auto-detected in the TUI. */
  theme?: ThemeName;
  /** Run a turn (or slash/skill command) through the shared agent runtime. */
  submit(
    text: string,
    events: TuiTurnEvents,
    requestApproval: (description: string) => Promise<boolean>,
  ): Promise<TuiTurnResult>;
  /** Abort the active turn, if any. */
  abort(): void;
  refreshEndpoints(): Promise<EndpointSummary[]>;
  addEndpoint(input: TuiAddEndpointInput): Promise<string>;
  updateEndpoint(
    endpointId: string,
    input: TuiAddEndpointInput,
  ): Promise<string>;
  selectModel(endpointId: string, model: string): Promise<string>;
  testEndpoint(endpointId: string): Promise<string>;
  validate(): Promise<string[]>;
  doctor(): Promise<TuiDoctorReport>;
  exportRedacted(): Promise<string>;
  /** Handle a defined slash command; returns null when it is not one of ours. */
  command?(text: string): Promise<string | null>;
  listSessions?(): Promise<TuiSessionSummary[]>;
  resumeSession?(id: string): Promise<TuiResumedSession>;
  listReviews?(): Promise<TuiReviewSummary[]>;
  acceptReview?(id: string): Promise<string>;
  rejectReview?(id: string): Promise<string>;
  listConfig?(): Promise<TuiConfigEntry[]>;
  setConfig?(key: string, value: string): Promise<string>;
  editConfig?(): Promise<string>;
  /** Open the prompt in $EDITOR and return the edited text. */
  openExternalEditor?(text: string): Promise<string | null>;
  listCommands?(): Promise<CommandSuggestion[]>;
  renameSession?(id: string, label: string): Promise<string>;
  forkSession?(id: string, label: string): Promise<string>;
  deleteSession?(id: string): Promise<string>;
  listMcpServers?(): Promise<McpServerStatus[]>;
  restartMcpServer?(name: string): Promise<string>;
  listCheckpoints?(): Promise<RecoverySnapshot[]>;
  rewindTo?(checkpointId: string): Promise<string>;
  getContext?(): Promise<ContextSnapshot>;
  listUsage?(): Promise<UsageRecord[]>;
  listPlan?(): Promise<PlanStepInput[]>;
  exit(): void;
}
