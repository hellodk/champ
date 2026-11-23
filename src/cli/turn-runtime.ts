/**
 * Transport-agnostic agent turn execution.
 *
 * The headless REPL and the full-screen TUI both drive `AgentController`
 * through this module. Stream deltas are delivered as events instead of being
 * written to stdout/stderr, so each frontend can render them without changing
 * agent behaviour or duplicating the turn loop.
 */
import type { AgentController } from "../agent/agent-controller";
import type { BudgetEnforcer } from "../config/budget";
import type { PolicyEngine } from "../policy/engine";
import type { StreamDelta, ToolCall, TokenUsage } from "../providers/types";

/** The smallest controller surface a turn needs. */
export type TurnController = Pick<
  AgentController,
  "onStreamDelta" | "processMessage"
>;

export interface TurnSummary {
  tools: number;
  usage: TokenUsage;
}

export interface TurnEvents {
  onText?: (chunk: string) => void;
  onTool?: (call: ToolCall) => void;
  onError?: (message: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  onDone?: (summary: TurnSummary) => void;
  onPersistError?: (message: string) => void;
}

export interface ExecuteTurnOptions {
  controller: TurnController;
  text: string;
  events?: TurnEvents;
  requestApproval?: (description: string) => Promise<boolean>;
  maxIterations?: number;
  headless?: boolean;
  budget?: BudgetEnforcer;
  policy?: PolicyEngine;
  onTurnEnd?: () => Promise<void>;
  /** Snapshot paths before mutating tools write. */
  onBeforeMutation?: (paths: string[]) => Promise<void>;
}

export interface TurnOutcome {
  text: string;
  error?: string;
  aborted: boolean;
}

let activeAbort: AbortController | null = null;

/** Abort signal for the turn currently in flight, if any. */
export function activeAbortSignal(): AbortSignal | null {
  return activeAbort?.signal ?? null;
}

/** Abort the active turn. Returns false when nothing is running. */
export function abortActiveTurn(): boolean {
  if (!activeAbort || activeAbort.signal.aborted) return false;
  activeAbort.abort();
  return true;
}

export function parseApprovalAnswer(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * Run one user message through the controller and fan the stream out to the
 * supplied events. No I/O is performed here.
 */
export async function executeTurn({
  controller,
  text,
  events = {},
  requestApproval,
  maxIterations,
  headless,
  budget,
  policy,
  onTurnEnd,
  onBeforeMutation,
}: ExecuteTurnOptions): Promise<TurnOutcome> {
  let sawText = false;
  let tools = 0;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const abort = new AbortController();
  activeAbort = abort;

  const dispose = controller.onStreamDelta((delta: StreamDelta) => {
    switch (delta.type) {
      case "text":
        events.onText?.(delta.text);
        sawText = true;
        break;
      case "tool_call_start":
        events.onTool?.(delta.toolCall);
        tools++;
        break;
      case "error":
        events.onError?.(delta.error);
        break;
      case "done":
        usage.inputTokens = delta.usage.inputTokens;
        usage.outputTokens = delta.usage.outputTokens;
        events.onUsage?.(delta.usage);
        break;
      default:
        break;
    }
  });

  try {
    const result = await controller.processMessage(text, {
      maxIterations,
      requestApproval,
      abortSignal: abort.signal,
      headless,
      budget,
      policy,
      onBeforeMutation,
    });
    if (!sawText && result.text) events.onText?.(result.text);
    events.onDone?.({ tools, usage });
    return { text: result.text, aborted: abort.signal.aborted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: "", error: message, aborted: abort.signal.aborted };
  } finally {
    activeAbort = null;
    dispose();
    if (onTurnEnd) {
      try {
        await onTurnEnd();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        events.onPersistError?.(message);
      }
    }
  }
}
