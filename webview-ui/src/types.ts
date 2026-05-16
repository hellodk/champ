// Browser-safe types mirroring src/ui/messages.ts and src/agent/team-definition.ts
// No vscode imports, no Node.js imports.

export interface EditSummary {
  path: string;
  oldContent: string;
  newContent: string;
}

export interface EditSummaryMessage {
  type: "editSummary";
  edits: EditSummary[];
}

export type TeamAgentStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "blocked";

export interface TeamAgentRunState {
  id: string;
  name: string;
  status: TeamAgentStatus;
  output: string;
  startTime?: number;
  endTime?: number;
  tokenCount: number;
  blockedReason?: string;
  validationWarnings: string[];
  retryCount: number;
}

export interface TeamRunState {
  runId: string;
  teamName: string;
  userRequest: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  agents: TeamAgentRunState[];
  sharedMemorySnapshot: Record<string, string>;
  startTime: number;
  endTime?: number;
  totalTokens: number;
  tokenBudget?: number;
  filesChanged: string[];
  mode: "auto" | "safe" | "supervised";
}

export interface McpMarketplaceEntry {
  name: string;
  description: string;
  author: string;
  url: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  baseUrl?: string;
  tags: string[];
}

export interface TeamRunSnapshotMessage {
  type: "teamRunSnapshot";
  state: TeamRunState;
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
