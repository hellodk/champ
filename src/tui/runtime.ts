/**
 * Boundary between the Ink UI and the headless Champ runtime.
 *
 * The TUI never imports the CLI entry point. The CLI builds the agent once and
 * hands this adapter across, so both frontends share providers, tools, rules,
 * sessions, policies and turn execution.
 */
import type { EndpointSummary, TuiScreen } from "./state";

export interface TuiHeader {
  version: string;
  model: string;
  workspace: string;
  sessionId?: string;
  routingMode?: string;
}

export interface TuiTurnEvents {
  onText?: (chunk: string) => void;
  onTool?: (name: string, args: string) => void;
  onError?: (message: string) => void;
  onDone?: (summary: {
    tools: number;
    inputTokens: number;
    outputTokens: number;
  }) => void;
}

export interface TuiTurnResult {
  text: string;
  error?: string;
  aborted: boolean;
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

export interface TuiRuntime {
  header: TuiHeader;
  initialEndpoints: EndpointSummary[];
  initialScreen?: TuiScreen;
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
  selectModel(endpointId: string, model: string): Promise<string>;
  testEndpoint(endpointId: string): Promise<string>;
  validate(): Promise<string[]>;
  doctor(): Promise<TuiDoctorReport>;
  exportRedacted(): Promise<string>;
  exit(): void;
}
