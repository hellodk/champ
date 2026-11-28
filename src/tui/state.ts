/**
 * Pure state container for the full-screen Ink TUI.
 *
 * Keeping transitions here makes the user interface testable without a
 * terminal and gives every screen one shared source of truth.
 */
import {
  categorizeTool,
  DEFAULT_TRANSCRIPT_CONFIG,
  nextVerbosity,
  type ActivityEntry,
  type ActivityGroup,
  type TranscriptDisplayConfig,
  type TranscriptVerbosity,
} from "./activity";
import {
  composerBackspace,
  composerDelete,
  composerInsert,
  composerMove,
  composerReplace,
  composerText,
  emptyComposer,
  type ComposerMove,
  type ComposerState,
} from "./composer";
import type { TuiTurnSummary } from "./runtime";
import {
  appendUsage,
  type ContextSnapshot,
  type UsageRecord,
} from "./insights";
import {
  applyMcpHealth,
  markMcpRestarting,
  type McpHealth,
  type McpServerStatus,
} from "./mcp";
import {
  advancePlan,
  setPlan,
  updatePlanStep,
  type PlanStep,
  type PlanStepInput,
  type PlanStepStatus,
} from "./plan";
import {
  emptyRecovery,
  recordRecovery,
  redoRecovery,
  rewindRecovery,
  undoRecovery,
  type RecoverySnapshot,
  type RecoveryState,
} from "./recovery";
import {
  deleteSession,
  forkSession,
  moveSessionTab,
  renameSession,
} from "./session-ops";
import {
  enqueueTask,
  finishTask,
  startNextTask,
  taskStateForSession,
  type SessionExecutionState,
  type TuiTask,
  type TuiTaskInput,
} from "./tasks";
import {
  toolSummary,
  type ToolRecord,
  type ToolResultEvent,
  type ToolStartEvent,
} from "./tool-events";

export type TuiScreen =
  | "chat"
  | "providers"
  | "config"
  | "help"
  | "sessions"
  | "review"
  | "tasks"
  | "plan"
  | "context"
  | "usage"
  | "mcp";

export interface TuiSessionSummary {
  id: string;
  label: string;
  updatedAt: string;
  preview?: string;
  parentId?: string;
  forkedFrom?: string;
}

export interface TuiReviewSummary {
  id: string;
  status: string;
  files: number;
  summary: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: string;
  streaming?: boolean;
  /** Links a transcript entry to the full structured tool event. */
  toolId?: string;
}

export type TurnItem =
  | { id: string; kind: "assistant_text"; text: string; streaming?: boolean }
  | { id: string; kind: "activity_group"; group: ActivityGroup }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "notice"; text: string };

export type TranscriptTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export interface TranscriptTurn {
  id: string;
  /** Null for standalone system/command output notices. */
  userMessage: string | null;
  startedAt: string;
  finishedAt?: string;
  items: TurnItem[];
  summary?: TuiTurnSummary;
  status: TranscriptTurnStatus;
}

export interface EndpointModelDetail {
  context?: number;
  evidence?: string;
  status?: string;
  pinned?: boolean;
}

export interface EndpointSummary {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  hasCredential: boolean;
  models: string[];
  /** Optional metadata for the selector; absent in legacy callers. */
  modelDetails?: Record<string, EndpointModelDetail>;
}

export interface SetupDraft {
  name: string;
  provider: string;
  baseUrl: string;
  credentialId: string;
  apiKey: string;
  model: string;
  open: boolean;
  saving: boolean;
  status?: string;
  error?: string;
}

export interface TuiState {
  screen: TuiScreen;
  workspace: string;
  model: string;
  endpoints: EndpointSummary[];
  selectedEndpointId?: string;
  selectedModel?: string;
  /** Structured turn-based transcript timeline rendered by the Chat screen. */
  turns: TranscriptTurn[];
  /** Legacy flat messages retained for backwards compatibility with existing callers. */
  messages: ChatMessage[];
  /** Verbosity and footer visibility settings for the transcript. */
  transcriptConfig: TranscriptDisplayConfig;
  /** Activity group IDs currently expanded inline in the transcript. */
  expandedActivityGroups: string[];
  /** Tool ID currently shown in the redacted tool detail drawer, if any. */
  inspectedToolId?: string;
  input: string;
  busy: boolean;
  status: string;
  setup: SetupDraft;
  diagnostics: string[];
  cursor: number;
  sessions: TuiSessionSummary[];
  sessionCursor: number;
  sessionFilter: string;
  reviews: TuiReviewSummary[];
  reviewCursor: number;
  /** Prompts submitted this session, oldest first. */
  history: string[];
  /** null means the user is drafting a fresh prompt. */
  historyCursor: number | null;
  draftInput: string;
  /** Rendered lines scrolled back from the newest transcript page. */
  scrollOffset: number;
  /** True while the viewport follows new output at the bottom. */
  autoFollow: boolean;
  /** Lines appended since the reader last looked at the newest page. */
  unseen: number;
  /** Line counts published by the renderer so the reducer can clamp. */
  totalLines: number;
  viewportLines: number;
  /** True once the retention cap has dropped older messages. */
  truncated: boolean;
  /** Tool messages whose full output is expanded in the transcript. */
  expandedTools: string[];
  /** Multiline prompt draft with an explicit cursor. */
  composer: ComposerState;
  /** Global command palette overlay. */
  paletteOpen: boolean;
  paletteQuery: string;
  paletteCursor: number;
  /** Full structured tool events keyed by tool id, never truncated here. */
  toolRecords: Record<string, ToolRecord>;
  tasks: TuiTask[];
  sessionExecutions: Record<string, SessionExecutionState>;
  plan: PlanStep[];
  context: ContextSnapshot;
  usage: UsageRecord[];
  mcpServers: McpServerStatus[];
  recovery: RecoveryState;
  sessionTabs: string[];
  activeSessionTab: number;
  activeSessionId?: string;
}

export type TuiAction =
  | { type: "screen/set"; screen: TuiScreen }
  | { type: "screen/next" }
  | { type: "input/set"; value: string }
  | { type: "turn/start" }
  | {
      type: "turn/complete";
      summary?: TuiTurnSummary;
      status?: Exclude<TranscriptTurnStatus, "running">;
    }
  | { type: "turn/stop" }
  | { type: "message/add"; role: ChatRole; text: string }
  | { type: "message/stream"; role: ChatRole; text: string }
  | { type: "reasoning/stream"; text: string }
  | {
      type: "turns/replace";
      turns: TranscriptTurn[];
      toolRecords?: Record<string, ToolRecord>;
    }
  | { type: "activity/toggle"; groupId: string }
  | { type: "activity/toggle-latest" }
  | { type: "tool/inspect"; toolId?: string }
  | { type: "verbosity/set"; verbosity: TranscriptVerbosity }
  | { type: "verbosity/cycle" }
  | { type: "transcript/config"; config: Partial<TranscriptDisplayConfig> }
  | { type: "status/set"; text: string }
  | { type: "endpoints/set"; endpoints: EndpointSummary[] }
  | { type: "endpoints/cursor"; delta: number }
  | { type: "model/select"; endpointId: string; model: string }
  | {
      type: "selection/set";
      endpointId?: string;
      model?: string;
      status?: string;
    }
  | { type: "setup/open" }
  | { type: "setup/cancel" }
  | { type: "setup/change"; field: keyof SetupDraft; value: string }
  | { type: "setup/submit" }
  | { type: "setup/result"; status: string; error?: boolean }
  | { type: "diagnostics/set"; lines: string[] }
  | { type: "messages/clear" }
  | { type: "sessions/set"; sessions: TuiSessionSummary[] }
  | { type: "sessions/cursor"; delta: number }
  | { type: "sessions/filter"; value: string }
  | { type: "reviews/set"; reviews: TuiReviewSummary[] }
  | { type: "reviews/cursor"; delta: number }
  | { type: "history/push"; value: string }
  | { type: "history/prev" }
  | { type: "history/next" }
  | { type: "transcript/scroll"; delta: number }
  | { type: "transcript/bottom" }
  | { type: "transcript/top" }
  | { type: "tool/toggle"; id: string }
  | {
      type: "transcript/metrics";
      totalLines: number;
      viewportLines: number;
      addedLines: number;
    }
  | { type: "composer/insert"; text: string }
  | { type: "composer/backspace" }
  | { type: "composer/delete" }
  | { type: "composer/move"; move: ComposerMove }
  | { type: "composer/replace"; text: string }
  | { type: "palette/open" }
  | { type: "palette/close" }
  | { type: "palette/query"; value: string }
  | { type: "palette/cursor"; delta: number }
  | { type: "tool/start"; event: ToolStartEvent }
  | { type: "tool/result"; event: ToolResultEvent }
  | { type: "tasks/enqueue"; task: TuiTaskInput }
  | { type: "tasks/start"; sessionId: string }
  | {
      type: "tasks/finish";
      id: string;
      status: "done" | "failed" | "cancelled";
    }
  | { type: "plan/set"; steps: readonly PlanStepInput[] }
  | { type: "plan/advance" }
  | { type: "plan/step"; id: string; status: PlanStepStatus }
  | { type: "context/set"; snapshot: ContextSnapshot }
  | { type: "usage/add"; record: UsageRecord }
  | { type: "usage/set"; records: UsageRecord[] }
  | { type: "mcp/set"; servers: McpServerStatus[] }
  | { type: "mcp/restarting"; name: string }
  | { type: "mcp/health"; name: string; health: McpHealth; error?: string }
  | { type: "recovery/record"; snapshot: RecoverySnapshot }
  | { type: "recovery/undo" }
  | { type: "recovery/redo" }
  | { type: "recovery/rewind"; id: string }
  | { type: "sessions/rename"; id: string; label: string }
  | {
      type: "sessions/fork";
      id: string;
      newId: string;
      label: string;
    }
  | { type: "sessions/delete"; id: string }
  | { type: "sessions/tab/add"; id: string }
  | { type: "sessions/tab/close" }
  | { type: "sessions/tab/move"; delta: number };

export interface TuiInitialState {
  workspace: string;
  model: string;
  endpoints: EndpointSummary[];
  selectedEndpointId?: string;
  selectedModel?: string;
  status?: string;
  transcriptConfig?: Partial<TranscriptDisplayConfig>;
}

const SCREENS: TuiScreen[] = [
  "chat",
  "providers",
  "config",
  "help",
  "sessions",
  "review",
  "tasks",
  "plan",
  "context",
  "usage",
  "mcp",
];
export const TRANSCRIPT_PAGE_SIZE = 18;
const MAX_MESSAGES = 2000;
const MAX_TURNS = 500;

let sequence = 0;
function nextId(prefix = "m"): string {
  sequence += 1;
  return `${prefix}${sequence}`;
}

function now(): string {
  return new Date().toISOString();
}

function emptySetup(): SetupDraft {
  return {
    name: "",
    provider: "openai-compatible",
    baseUrl: "",
    credentialId: "",
    apiKey: "",
    model: "",
    open: false,
    saving: false,
  };
}

export function initialTuiState(input: TuiInitialState): TuiState {
  return {
    screen: "chat",
    workspace: input.workspace,
    model: input.model,
    endpoints: input.endpoints,
    selectedEndpointId: input.selectedEndpointId,
    selectedModel: input.selectedModel,
    turns: [],
    messages: [],
    transcriptConfig: {
      ...DEFAULT_TRANSCRIPT_CONFIG,
      ...input.transcriptConfig,
    },
    expandedActivityGroups: [],
    inspectedToolId: undefined,
    input: "",
    busy: false,
    status: input.status ?? "Ready",
    setup: emptySetup(),
    diagnostics: [],
    cursor: 0,
    sessions: [],
    sessionCursor: 0,
    sessionFilter: "",
    reviews: [],
    reviewCursor: 0,
    history: [],
    historyCursor: null,
    draftInput: "",
    scrollOffset: 0,
    autoFollow: true,
    unseen: 0,
    totalLines: 0,
    viewportLines: 0,
    truncated: false,
    expandedTools: [],
    composer: emptyComposer(),
    paletteOpen: false,
    paletteQuery: "",
    paletteCursor: 0,
    toolRecords: {},
    tasks: [],
    sessionExecutions: {},
    plan: [],
    context: {
      usedTokens: 0,
      limit: 128000,
      model: input.model,
      messages: 0,
      compactions: [],
    },
    usage: [],
    mcpServers: [],
    recovery: emptyRecovery({
      id: "session-start",
      label: "Session start",
      at: now(),
    }),
    sessionTabs: [],
    activeSessionTab: 0,
    activeSessionId: undefined,
  };
}

function withInput(state: TuiState, value: string): TuiState {
  return {
    ...state,
    input: value,
    composer: composerReplace(state.composer, value),
  };
}

function withComposer(state: TuiState, composer: ComposerState): TuiState {
  const value = composerText(composer);
  return {
    ...state,
    composer,
    input: value,
    draftInput: value,
    historyCursor: null,
  };
}

function withExecution(
  state: TuiState,
  tasks: TuiTask[],
  sessionIds: readonly string[],
): TuiState {
  const executions = { ...state.sessionExecutions };
  for (const sessionId of sessionIds) {
    executions[sessionId] = taskStateForSession(tasks, sessionId);
  }
  return { ...state, tasks, sessionExecutions: executions };
}

function clampCursor(state: TuiState, delta: number): number {
  if (state.endpoints.length === 0) return 0;
  const next = state.cursor + delta;
  return Math.max(0, Math.min(state.endpoints.length - 1, next));
}

function clampIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, current + delta));
}

function appendMessage(
  state: TuiState,
  role: ChatRole,
  text: string,
  streaming: boolean,
  toolId?: string,
): ChatMessage[] {
  const last = state.messages[state.messages.length - 1];
  if (
    streaming &&
    last?.streaming &&
    last.role === role &&
    role === "assistant"
  ) {
    const updated = { ...last, text: last.text + text };
    return [...state.messages.slice(0, -1), updated];
  }
  const message: ChatMessage = {
    id: nextId("m"),
    role,
    text,
    timestamp: now(),
    streaming: streaming && role === "assistant",
    ...(toolId === undefined ? {} : { toolId }),
  };
  return [...state.messages, message].slice(-MAX_MESSAGES);
}

function activeTurnIndex(turns: readonly TranscriptTurn[]): number {
  const last = turns[turns.length - 1];
  return last && last.status === "running" ? turns.length - 1 : -1;
}

function updateTurnAt(
  turns: readonly TranscriptTurn[],
  index: number,
  updater: (turn: TranscriptTurn) => TranscriptTurn,
): TranscriptTurn[] {
  return turns.map((turn, idx) => (idx === index ? updater(turn) : turn));
}

function closeOpenReasoningInGroup(
  group: ActivityGroup,
  timestamp: string,
): ActivityGroup {
  const last = group.entries[group.entries.length - 1];
  if (!last || last.kind !== "reasoning" || last.status !== "running") {
    return group;
  }
  const durationMs = Math.max(
    0,
    Date.parse(timestamp) - Date.parse(last.startedAt),
  );
  return {
    ...group,
    entries: [
      ...group.entries.slice(0, -1),
      {
        ...last,
        status: "done",
        finishedAt: timestamp,
        durationMs: Number.isNaN(durationMs) ? last.durationMs : durationMs,
      },
    ],
  };
}

function closeOpenReasoningInTurn(
  turn: TranscriptTurn,
  timestamp: string,
): TranscriptTurn {
  const last = turn.items[turn.items.length - 1];
  if (!last || last.kind !== "activity_group") return turn;
  const closed = closeOpenReasoningInGroup(last.group, timestamp);
  if (closed === last.group) return turn;
  return {
    ...turn,
    items: [...turn.items.slice(0, -1), { ...last, group: closed }],
  };
}

function appendAssistantToTurns(
  turns: readonly TranscriptTurn[],
  text: string,
  streaming: boolean,
): TranscriptTurn[] {
  const timestamp = now();
  let index = activeTurnIndex(turns);
  let working: TranscriptTurn[] = [...turns];
  if (index === -1) {
    const synthetic: TranscriptTurn = {
      id: nextId("turn"),
      userMessage: null,
      startedAt: timestamp,
      items: [],
      status: streaming ? "running" : "completed",
      ...(streaming ? {} : { finishedAt: timestamp }),
    };
    working = [...working, synthetic].slice(-MAX_TURNS);
    index = working.length - 1;
  }

  return updateTurnAt(working, index, (rawTurn) => {
    const turn = closeOpenReasoningInTurn(rawTurn, timestamp);
    const last = turn.items[turn.items.length - 1];
    if (streaming && last?.kind === "assistant_text" && last.streaming) {
      return {
        ...turn,
        items: [
          ...turn.items.slice(0, -1),
          { ...last, text: last.text + text },
        ],
      };
    }
    return {
      ...turn,
      items: [
        ...turn.items,
        {
          id: nextId("item"),
          kind: "assistant_text",
          text,
          streaming,
        },
      ],
    };
  });
}

function appendReasoningToTurns(
  turns: readonly TranscriptTurn[],
  text: string,
): TranscriptTurn[] {
  if (!text) return [...turns];
  const timestamp = now();
  let index = activeTurnIndex(turns);
  let working: TranscriptTurn[] = [...turns];
  if (index === -1) {
    working = [
      ...working,
      {
        id: nextId("turn"),
        userMessage: null,
        startedAt: timestamp,
        items: [],
        status: "running" as const,
      },
    ].slice(-MAX_TURNS);
    index = working.length - 1;
  }

  return updateTurnAt(working, index, (turn) => {
    const items = turn.items.map((item, idx) =>
      idx === turn.items.length - 1 && item.kind === "assistant_text"
        ? { ...item, streaming: false }
        : item,
    );
    const last = items[items.length - 1];
    if (last?.kind === "activity_group") {
      const lastEntry = last.group.entries[last.group.entries.length - 1];
      if (lastEntry?.kind === "reasoning" && lastEntry.status === "running") {
        const elapsed = Math.max(
          0,
          Date.parse(timestamp) - Date.parse(lastEntry.startedAt),
        );
        const updatedEntry: ActivityEntry = {
          ...lastEntry,
          reasoningText: (lastEntry.reasoningText ?? "") + text,
          durationMs: Number.isNaN(elapsed) ? lastEntry.durationMs : elapsed,
        };
        return {
          ...turn,
          items: [
            ...items.slice(0, -1),
            {
              ...last,
              group: {
                ...last.group,
                entries: [...last.group.entries.slice(0, -1), updatedEntry],
              },
            },
          ],
        };
      }
      const entry: ActivityEntry = {
        id: nextId("act"),
        kind: "reasoning",
        category: "thinking",
        reasoningText: text,
        startedAt: timestamp,
        status: "running",
      };
      return {
        ...turn,
        items: [
          ...items.slice(0, -1),
          {
            ...last,
            group: {
              ...last.group,
              entries: [...last.group.entries, entry],
            },
          },
        ],
      };
    }

    const groupId = nextId("grp");
    const entry: ActivityEntry = {
      id: nextId("act"),
      kind: "reasoning",
      category: "thinking",
      reasoningText: text,
      startedAt: timestamp,
      status: "running",
    };
    return {
      ...turn,
      items: [
        ...items,
        {
          id: nextId("item"),
          kind: "activity_group",
          group: { id: groupId, entries: [entry] },
        },
      ],
    };
  });
}

function appendToolStartToTurns(
  turns: readonly TranscriptTurn[],
  event: ToolStartEvent,
): TranscriptTurn[] {
  const timestamp = event.startedAt ?? now();
  let index = activeTurnIndex(turns);
  let working: TranscriptTurn[] = [...turns];
  if (index === -1) {
    working = [
      ...working,
      {
        id: nextId("turn"),
        userMessage: null,
        startedAt: timestamp,
        items: [],
        status: "running" as const,
      },
    ].slice(-MAX_TURNS);
    index = working.length - 1;
  }

  const entry: ActivityEntry = {
    id: nextId("act"),
    kind: "tool",
    category: categorizeTool(event.name),
    toolId: event.id,
    toolName: event.name,
    startedAt: timestamp,
    status: "running",
  };

  return updateTurnAt(working, index, (turn) => {
    const items = turn.items.map((item, idx) =>
      idx === turn.items.length - 1 && item.kind === "assistant_text"
        ? { ...item, streaming: false }
        : item,
    );
    const last = items[items.length - 1];
    if (last?.kind === "activity_group") {
      const closedGroup = closeOpenReasoningInGroup(last.group, timestamp);
      return {
        ...turn,
        items: [
          ...items.slice(0, -1),
          {
            ...last,
            group: {
              ...closedGroup,
              entries: [...closedGroup.entries, entry],
            },
          },
        ],
      };
    }
    const groupId = nextId("grp");
    return {
      ...turn,
      items: [
        ...items,
        {
          id: nextId("item"),
          kind: "activity_group",
          group: { id: groupId, entries: [entry] },
        },
      ],
    };
  });
}

function completeToolInTurns(
  turns: readonly TranscriptTurn[],
  event: ToolResultEvent,
): TranscriptTurn[] {
  const timestamp = now();
  const nextStatus: ActivityEntry["status"] = event.success ? "done" : "failed";

  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const turn = turns[t];
    for (let i = turn.items.length - 1; i >= 0; i -= 1) {
      const item = turn.items[i];
      if (item.kind !== "activity_group") continue;
      const entryIdx = item.group.entries.findIndex(
        (entry) => entry.kind === "tool" && entry.toolId === event.id,
      );
      if (entryIdx === -1) continue;
      return updateTurnAt(turns, t, (targetTurn) => ({
        ...targetTurn,
        items: targetTurn.items.map((candidate, idx) => {
          if (idx !== i || candidate.kind !== "activity_group") {
            return candidate;
          }
          return {
            ...candidate,
            group: {
              ...candidate.group,
              entries: candidate.group.entries.map((entry, eIdx) =>
                eIdx === entryIdx
                  ? {
                      ...entry,
                      status: nextStatus,
                      finishedAt: timestamp,
                      durationMs: event.durationMs ?? entry.durationMs,
                    }
                  : entry,
              ),
            },
          };
        }),
      }));
    }
  }

  // Fallback when a result arrives without a matching start event.
  const started = appendToolStartToTurns(turns, {
    id: event.id,
    name: event.name,
    args: "",
    startedAt: timestamp,
  });
  return completeToolInTurns(started, event);
}

function appendItemToActiveOrStandaloneTurn(
  turns: readonly TranscriptTurn[],
  item: { kind: "error"; text: string } | { kind: "notice"; text: string },
): TranscriptTurn[] {
  const timestamp = now();
  const index = activeTurnIndex(turns);
  if (item.kind === "error" && index !== -1) {
    return updateTurnAt(turns, index, (turn) => ({
      ...turn,
      items: [...turn.items, { id: nextId("item"), ...item }],
    }));
  }
  const standalone: TranscriptTurn = {
    id: nextId("turn"),
    userMessage: null,
    startedAt: timestamp,
    finishedAt: timestamp,
    items: [{ id: nextId("item"), ...item }],
    status: item.kind === "error" ? "failed" : "completed",
  };
  return [...turns, standalone].slice(-MAX_TURNS);
}

function finalizeActiveTurn(
  turns: readonly TranscriptTurn[],
  status: Exclude<TranscriptTurnStatus, "running">,
  summary?: TuiTurnSummary,
): TranscriptTurn[] {
  const index = activeTurnIndex(turns);
  const targetIndex =
    index !== -1 ? index : summary && turns.length > 0 ? turns.length - 1 : -1;
  if (targetIndex === -1) return [...turns];

  const timestamp = now();
  return updateTurnAt(turns, targetIndex, (turn) => ({
    ...turn,
    status: turn.status === "running" ? status : turn.status,
    finishedAt: turn.finishedAt ?? timestamp,
    ...(summary ? { summary } : {}),
    items: turn.items.map((item) => {
      if (item.kind === "assistant_text" && item.streaming) {
        return { ...item, streaming: false };
      }
      if (item.kind === "activity_group") {
        return {
          ...item,
          group: {
            ...item.group,
            entries: item.group.entries.map((entry) => {
              if (entry.status !== "running") return entry;
              const elapsed = Math.max(
                0,
                Date.parse(timestamp) - Date.parse(entry.startedAt),
              );
              return {
                ...entry,
                status: status === "completed" ? "done" : "failed",
                finishedAt: timestamp,
                durationMs:
                  entry.durationMs ?? (Number.isNaN(elapsed) ? 0 : elapsed),
              };
            }),
          },
        };
      }
      return item;
    }),
  }));
}

export function latestActivityGroupId(
  turns: readonly TranscriptTurn[],
): string | undefined {
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const items = turns[t].items;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.kind === "activity_group") return item.group.id;
    }
  }
  return undefined;
}

function latestToolIdInGroup(
  turns: readonly TranscriptTurn[],
  groupId: string,
): string | undefined {
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    for (const item of turns[t].items) {
      if (item.kind !== "activity_group" || item.group.id !== groupId) continue;
      for (let e = item.group.entries.length - 1; e >= 0; e -= 1) {
        const entry = item.group.entries[e];
        if (entry.kind === "tool" && entry.toolId) return entry.toolId;
      }
      return undefined;
    }
  }
  return undefined;
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "screen/set":
      return { ...state, screen: action.screen };
    case "screen/next": {
      const index = SCREENS.indexOf(state.screen);
      return { ...state, screen: SCREENS[(index + 1) % SCREENS.length] };
    }
    case "input/set":
      return {
        ...withInput(state, action.value),
        historyCursor: null,
        draftInput: action.value,
      };
    case "turn/start": {
      const submitted = state.input.trim();
      const timestamp = now();
      const nextTurn: TranscriptTurn = {
        id: nextId("turn"),
        userMessage: submitted,
        startedAt: timestamp,
        items: [],
        status: "running",
      };
      return {
        ...state,
        busy: true,
        status: "Thinking…",
        turns: [...state.turns, nextTurn].slice(-MAX_TURNS),
        messages: appendMessage(state, "user", submitted, false),
        input: "",
        composer: emptyComposer(),
        draftInput: "",
        historyCursor: null,
        history: submitted ? [...state.history, submitted] : state.history,
        truncated:
          state.truncated ||
          state.messages.length >= MAX_MESSAGES ||
          state.turns.length >= MAX_TURNS,
      };
    }
    case "turn/complete": {
      const status = action.status ?? "completed";
      return {
        ...state,
        turns: finalizeActiveTurn(state.turns, status, action.summary),
      };
    }
    case "turn/stop": {
      const messages = state.messages.map((message, index) =>
        index === state.messages.length - 1
          ? { ...message, streaming: false }
          : message,
      );
      return {
        ...state,
        busy: false,
        turns: finalizeActiveTurn(state.turns, "completed"),
        messages,
      };
    }
    case "message/add": {
      let turns = state.turns;
      if (action.role === "user") {
        const timestamp = now();
        const userTurn: TranscriptTurn = {
          id: nextId("turn"),
          userMessage: action.text,
          startedAt: timestamp,
          finishedAt: timestamp,
          items: [],
          status: "completed",
        };
        turns = [...state.turns, userTurn].slice(-MAX_TURNS);
      } else if (action.role === "assistant") {
        turns = appendAssistantToTurns(state.turns, action.text, false);
      } else if (action.role === "error") {
        turns = appendItemToActiveOrStandaloneTurn(state.turns, {
          kind: "error",
          text: action.text,
        });
      } else if (action.role === "system") {
        turns = appendItemToActiveOrStandaloneTurn(state.turns, {
          kind: "notice",
          text: action.text,
        });
      }
      return {
        ...state,
        turns,
        messages: appendMessage(state, action.role, action.text, false),
        truncated:
          state.truncated ||
          state.messages.length >= MAX_MESSAGES ||
          state.turns.length >= MAX_TURNS,
      };
    }
    case "message/stream":
      return {
        ...state,
        turns:
          action.role === "assistant"
            ? appendAssistantToTurns(state.turns, action.text, true)
            : state.turns,
        messages: appendMessage(state, action.role, action.text, true),
        truncated:
          state.truncated ||
          state.messages.length >= MAX_MESSAGES ||
          state.turns.length >= MAX_TURNS,
      };
    case "reasoning/stream":
      return {
        ...state,
        turns: appendReasoningToTurns(state.turns, action.text),
      };
    case "turns/replace":
      return {
        ...state,
        turns: action.turns.slice(-MAX_TURNS),
        toolRecords: action.toolRecords ?? {},
        expandedActivityGroups: [],
        expandedTools: [],
        inspectedToolId: undefined,
        truncated: action.turns.length > MAX_TURNS,
        scrollOffset: 0,
        autoFollow: true,
        unseen: 0,
      };
    case "activity/toggle": {
      const wasExpanded = state.expandedActivityGroups.includes(action.groupId);
      const expanded = wasExpanded
        ? state.expandedActivityGroups.filter((id) => id !== action.groupId)
        : [...state.expandedActivityGroups, action.groupId];
      return {
        ...state,
        expandedActivityGroups: expanded,
        inspectedToolId: wasExpanded
          ? undefined
          : latestToolIdInGroup(state.turns, action.groupId),
      };
    }
    case "activity/toggle-latest": {
      const groupId = latestActivityGroupId(state.turns);
      if (!groupId) return state;
      const wasExpanded = state.expandedActivityGroups.includes(groupId);
      const expanded = wasExpanded
        ? state.expandedActivityGroups.filter((id) => id !== groupId)
        : [...state.expandedActivityGroups, groupId];
      return {
        ...state,
        expandedActivityGroups: expanded,
        inspectedToolId: wasExpanded
          ? undefined
          : latestToolIdInGroup(state.turns, groupId),
      };
    }
    case "tool/inspect":
      return { ...state, inspectedToolId: action.toolId };
    case "verbosity/set":
      return {
        ...state,
        transcriptConfig: {
          ...state.transcriptConfig,
          verbosity: action.verbosity,
        },
        status: `Verbosity: ${action.verbosity}`,
      };
    case "verbosity/cycle": {
      const next = nextVerbosity(state.transcriptConfig.verbosity);
      return {
        ...state,
        transcriptConfig: {
          ...state.transcriptConfig,
          verbosity: next,
        },
        status: `Verbosity: ${next}`,
      };
    }
    case "transcript/config":
      return {
        ...state,
        transcriptConfig: {
          ...state.transcriptConfig,
          ...action.config,
        },
      };
    case "status/set":
      return { ...state, status: action.text };
    case "endpoints/set":
      return {
        ...state,
        endpoints: action.endpoints,
        cursor: Math.min(
          state.cursor,
          Math.max(0, action.endpoints.length - 1),
        ),
      };
    case "endpoints/cursor":
      return { ...state, cursor: clampCursor(state, action.delta) };
    case "model/select":
      return {
        ...state,
        selectedEndpointId: action.endpointId,
        selectedModel: action.model,
        status: `Model ${action.model} selected`,
      };
    case "selection/set":
      return {
        ...state,
        selectedEndpointId: action.endpointId ?? state.selectedEndpointId,
        selectedModel: action.model ?? state.selectedModel,
        status: action.status ?? state.status,
      };
    case "setup/open":
      return {
        ...state,
        screen: "providers",
        setup: { ...emptySetup(), open: true },
      };
    case "setup/cancel":
      return { ...state, setup: emptySetup() };
    case "setup/change":
      return {
        ...state,
        setup: {
          ...state.setup,
          [action.field]: action.value,
          error: undefined,
        },
      };
    case "setup/submit": {
      if (!state.setup.name.trim()) {
        return {
          ...state,
          setup: { ...state.setup, error: "Endpoint name is required" },
        };
      }
      return {
        ...state,
        setup: { ...state.setup, saving: true, error: undefined },
      };
    }
    case "setup/result":
      return {
        ...state,
        setup: {
          ...state.setup,
          open: false,
          saving: false,
          status: action.status,
          error: action.error ? action.status : undefined,
        },
        status: action.status,
      };
    case "diagnostics/set":
      return { ...state, diagnostics: action.lines };
    case "messages/clear":
      return {
        ...state,
        turns: [],
        messages: [],
        toolRecords: {},
        expandedActivityGroups: [],
        expandedTools: [],
        inspectedToolId: undefined,
        truncated: false,
        status: "New session",
        scrollOffset: 0,
        autoFollow: true,
        unseen: 0,
      };
    case "sessions/set":
      return {
        ...state,
        sessions: action.sessions,
        sessionCursor: Math.min(
          state.sessionCursor,
          Math.max(0, action.sessions.length - 1),
        ),
      };
    case "sessions/cursor":
      return {
        ...state,
        sessionCursor: clampIndex(
          state.sessionCursor,
          action.delta,
          state.sessions.length,
        ),
      };
    case "sessions/filter":
      return { ...state, sessionFilter: action.value, sessionCursor: 0 };
    case "reviews/set":
      return {
        ...state,
        reviews: action.reviews,
        reviewCursor: Math.min(
          state.reviewCursor,
          Math.max(0, action.reviews.length - 1),
        ),
      };
    case "reviews/cursor":
      return {
        ...state,
        reviewCursor: clampIndex(
          state.reviewCursor,
          action.delta,
          state.reviews.length,
        ),
      };
    case "history/push":
      return {
        ...state,
        history: [...state.history, action.value].slice(-200),
        historyCursor: null,
        draftInput: "",
      };
    case "history/prev": {
      if (state.history.length === 0) return state;
      const cursor =
        state.historyCursor === null
          ? state.history.length - 1
          : Math.max(0, state.historyCursor - 1);
      return {
        ...withInput(state, state.history[cursor]),
        historyCursor: cursor,
      };
    }
    case "history/next": {
      if (state.historyCursor === null) return state;
      const next = state.historyCursor + 1;
      if (next >= state.history.length) {
        return {
          ...withInput(state, state.draftInput),
          historyCursor: null,
        };
      }
      return {
        ...withInput(state, state.history[next]),
        historyCursor: next,
      };
    }
    case "transcript/metrics": {
      const max = Math.max(0, action.totalLines - action.viewportLines);
      const scrollOffset = Math.max(0, Math.min(max, state.scrollOffset));
      const atBottom = scrollOffset === 0;
      return {
        ...state,
        totalLines: action.totalLines,
        viewportLines: action.viewportLines,
        scrollOffset,
        autoFollow: atBottom,
        unseen: atBottom ? 0 : state.unseen + Math.max(0, action.addedLines),
      };
    }
    case "transcript/scroll": {
      const max = Math.max(0, state.totalLines - state.viewportLines);
      const scrollOffset = Math.max(
        0,
        Math.min(max, state.scrollOffset - action.delta),
      );
      return {
        ...state,
        scrollOffset,
        autoFollow: scrollOffset === 0,
        unseen: scrollOffset === 0 ? 0 : state.unseen,
      };
    }
    case "transcript/bottom":
      return { ...state, scrollOffset: 0, autoFollow: true, unseen: 0 };
    case "transcript/top":
      return {
        ...state,
        scrollOffset: Math.max(0, state.totalLines - state.viewportLines),
        autoFollow: false,
      };
    case "tool/toggle":
      return {
        ...state,
        expandedTools: state.expandedTools.includes(action.id)
          ? state.expandedTools.filter((id) => id !== action.id)
          : [...state.expandedTools, action.id],
      };
    case "composer/insert":
      return withComposer(state, composerInsert(state.composer, action.text));
    case "composer/backspace":
      return withComposer(state, composerBackspace(state.composer));
    case "composer/delete":
      return withComposer(state, composerDelete(state.composer));
    case "composer/move":
      return withComposer(state, composerMove(state.composer, action.move));
    case "composer/replace":
      return withComposer(state, composerReplace(state.composer, action.text));
    case "palette/open":
      return {
        ...state,
        paletteOpen: true,
        paletteQuery: "",
        paletteCursor: 0,
      };
    case "palette/close":
      return { ...state, paletteOpen: false };
    case "palette/query":
      return { ...state, paletteQuery: action.value, paletteCursor: 0 };
    case "palette/cursor":
      return {
        ...state,
        paletteCursor: Math.max(0, state.paletteCursor + action.delta),
      };
    case "tool/start": {
      const record: ToolRecord = { start: action.event };
      return {
        ...state,
        turns: appendToolStartToTurns(state.turns, action.event),
        messages: appendMessage(
          state,
          "tool",
          toolSummary(record, 120),
          false,
          action.event.id,
        ),
        toolRecords: { ...state.toolRecords, [action.event.id]: record },
      };
    }
    case "tool/result": {
      const previous = state.toolRecords[action.event.id];
      const record: ToolRecord = previous
        ? { ...previous, result: action.event }
        : {
            start: {
              id: action.event.id,
              name: action.event.name,
              args: "",
            },
            result: action.event,
          };
      const firstLine = action.event.output.trim().split("\n")[0] ?? "";
      const text = `${action.event.success ? "✓" : "✗"} ${action.event.name}${
        firstLine ? ` → ${firstLine.slice(0, 80)}` : ""
      }`;
      return {
        ...state,
        turns: completeToolInTurns(state.turns, action.event),
        messages: appendMessage(
          state,
          action.event.success ? "system" : "error",
          text,
          false,
          action.event.id,
        ),
        toolRecords: { ...state.toolRecords, [action.event.id]: record },
      };
    }
    case "tasks/enqueue": {
      const tasks = enqueueTask(state.tasks, action.task, now());
      return withExecution(state, tasks, [action.task.sessionId]);
    }
    case "tasks/start": {
      const tasks = startNextTask(state.tasks, action.sessionId, now());
      return withExecution(state, tasks, [action.sessionId]);
    }
    case "tasks/finish": {
      const task = state.tasks.find((item) => item.id === action.id);
      const tasks = finishTask(state.tasks, action.id, action.status, now());
      return withExecution(state, tasks, task ? [task.sessionId] : []);
    }
    case "plan/set":
      return { ...state, plan: setPlan(action.steps) };
    case "plan/advance":
      return { ...state, plan: advancePlan(state.plan) };
    case "plan/step":
      return {
        ...state,
        plan: updatePlanStep(state.plan, action.id, action.status),
      };
    case "context/set":
      return { ...state, context: action.snapshot };
    case "usage/add":
      return { ...state, usage: appendUsage(state.usage, action.record) };
    case "usage/set":
      return { ...state, usage: action.records.slice(-200) };
    case "mcp/set":
      return { ...state, mcpServers: action.servers };
    case "mcp/restarting":
      return {
        ...state,
        mcpServers: markMcpRestarting(state.mcpServers, action.name),
      };
    case "mcp/health":
      return {
        ...state,
        mcpServers: applyMcpHealth(
          state.mcpServers,
          action.name,
          action.health,
          action.error,
        ),
      };
    case "recovery/record":
      return {
        ...state,
        recovery: recordRecovery(state.recovery, action.snapshot),
      };
    case "recovery/undo":
      return { ...state, recovery: undoRecovery(state.recovery) };
    case "recovery/redo":
      return { ...state, recovery: redoRecovery(state.recovery) };
    case "recovery/rewind":
      return {
        ...state,
        recovery: rewindRecovery(state.recovery, action.id),
      };
    case "sessions/rename":
      return {
        ...state,
        sessions: renameSession(state.sessions, action.id, action.label),
      };
    case "sessions/fork":
      return {
        ...state,
        sessions: forkSession(
          state.sessions,
          action.id,
          action.newId,
          action.label,
        ),
        sessionTabs: [...state.sessionTabs, action.newId].slice(-8),
      };
    case "sessions/delete": {
      const sessions = deleteSession(state.sessions, action.id);
      const tabs = state.sessionTabs.filter((tab) => tab !== action.id);
      return {
        ...state,
        sessions,
        sessionTabs: tabs,
        activeSessionTab: Math.min(
          state.activeSessionTab,
          Math.max(0, tabs.length - 1),
        ),
      };
    }
    case "sessions/tab/add": {
      if (state.sessionTabs.includes(action.id)) return state;
      const tabs = [...state.sessionTabs, action.id].slice(-8);
      return { ...state, sessionTabs: tabs, activeSessionTab: tabs.length - 1 };
    }
    case "sessions/tab/close": {
      const tabs = state.sessionTabs.filter(
        (_tab, index) => index !== state.activeSessionTab,
      );
      return {
        ...state,
        sessionTabs: tabs,
        activeSessionTab: Math.min(
          state.activeSessionTab,
          Math.max(0, tabs.length - 1),
        ),
      };
    }
    case "sessions/tab/move":
      return {
        ...state,
        activeSessionTab: moveSessionTab(
          state.sessionTabs,
          state.activeSessionTab,
          action.delta,
        ),
      };
    default:
      return state;
  }
}
