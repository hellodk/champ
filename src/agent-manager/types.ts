/**
 * Types for the multi-session agent manager.
 *
 * An AgentSession wraps an AgentController with metadata (label,
 * state, timestamps). The AgentManager holds a Map of sessions and
 * routes messages to the active one.
 */
import type { AgentMode } from "../agent/agent-controller";
import type { LLMMessage } from "../providers/types";

export type SessionState =
  | "idle"
  | "running"
  | "aborted"
  | "errored"
  | "completed";

export interface SessionMetadata {
  id: string;
  label: string;
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;
  mode: AgentMode;
  messageCount: number;
  modifiedFiles: string[];
  archived: boolean;
}

export interface SerializedSession {
  version: 1;
  metadata: SessionMetadata;
  history: LLMMessage[];
}

export type ManagerEvent =
  | { type: "sessionCreated"; id: string }
  | { type: "sessionStateChanged"; id: string; state: SessionState }
  | { type: "activeChanged"; id: string | null }
  | { type: "sessionDeleted"; id: string }
  | { type: "sessionUpdated"; id: string };

// ── Analytics types ────────────────────────────────────────────────

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  durationMs: number;
  success: boolean;
  result?: string;
  error?: string;
}

export interface AgentTaskRecord {
  agentName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: ToolCallRecord[];
  success: boolean;
  error?: string;
}

export interface AgentRunReport {
  runId: string;
  startTime: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  success: boolean;
  agents: AgentTaskRecord[];
}
