/**
 * Transport-agnostic agent turn execution.
 *
 * The headless REPL and the full-screen TUI both drive `AgentController`
 * through this module. Stream deltas are delivered as events instead of being
 * written to stdout/stderr, so each frontend can render them without changing
 * agent behaviour or duplicating the turn loop.
 */
import type { AgentController } from "../agent/agent-controller";
import { quoteCost, type BudgetEnforcer } from "../config/budget";
import type { PolicyEngine } from "../policy/engine";
import {
  createExecutionCorrelation,
  type ExecutionCorrelation,
} from "../observability/trace-context";
import type { StreamDelta, ToolCall, TokenUsage } from "../providers/types";

/** The smallest controller surface a turn needs. */
export type TurnController = Pick<
  AgentController,
  "onStreamDelta" | "processMessage"
>;

export interface TurnContextInfo {
  used: number;
  window: number;
  remaining: number;
  percentUsed: number;
}

export interface TurnCostInfo {
  usd: number | null;
  known: boolean;
  pricingVersion: string;
  source: "local" | "table" | "unknown";
}

export interface TurnSummary {
  tools: number;
  usage: TokenUsage;
  durationMs?: number;
  toolDurationMs?: number;
  firstTokenMs?: number;
  model?: string;
  provider?: string;
  cost?: TurnCostInfo;
  context?: TurnContextInfo;
  retries?: number;
  fallbacks?: number;
  compactions?: number;
  runId?: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  spanId?: string;
}

export interface ToolCompletionEvent {
  id?: string;
  name?: string;
  output: string;
  success: boolean;
  /** Optional execution metadata, supplied by richer tool runtimes. */
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  approval?: "approved" | "denied" | "auto";
  error?: string;
  fileEditDiff?: { path: string; oldContent: string; newContent: string };
  testsSummary?: { passed: number; failed: number; skipped: number };
}

export interface TurnEvents {
  onText?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onTool?: (call: ToolCall) => void;
  onToolResult?: (result: ToolCompletionEvent) => void;
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
  permissionProfile?: import("../policy/profiles").PermissionProfile;
  onTurnEnd?: () => Promise<void>;
  /** Snapshot paths before mutating tools write. */
  onBeforeMutation?: (paths: string[]) => Promise<void>;
  correlation?: Partial<ExecutionCorrelation>;
  /** Suppress synthetic "Using `tool`…" text deltas when structured activity UI is active. */
  suppressToolNarration?: boolean;
}

/** Additive outcome classification; exit codes are derived from this. */
export type TurnStatus = "success" | "partial" | "failed" | "cancelled";

export interface TurnOutcome {
  text: string;
  error?: string;
  aborted: boolean;
  status: TurnStatus;
}

/** Classify a turn so every frontend maps the same outcome the same way. */
export function turnStatus(outcome: {
  text: string;
  error?: string;
  aborted: boolean;
}): TurnStatus {
  if (outcome.aborted) return "cancelled";
  if (!outcome.error) return "success";
  return outcome.text.trim() ? "partial" : "failed";
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
  permissionProfile,
  onTurnEnd,
  onBeforeMutation,
  correlation: initialCorrelation,
  suppressToolNarration,
}: ExecuteTurnOptions): Promise<TurnOutcome> {
  const correlation = createExecutionCorrelation(initialCorrelation);
  let sawText = false;
  let tools = 0;
  const startTime = Date.now();
  let firstTokenTime = 0;
  let toolDurationMs = 0;
  const toolStartTimes = new Map<string, number>();

  // Error deltas are how providers and the budget enforcer report failures —
  // processMessage returns normally in that case, so the only way a caller can
  // tell the turn failed is by surfacing the delta here.
  let streamError: string | undefined;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let latestContextUsed = 0;
  const abort = new AbortController();
  activeAbort = abort;

  const dispose = controller.onStreamDelta((delta: StreamDelta) => {
    switch (delta.type) {
      case "text":
      case "reasoning":
        if (!firstTokenTime) firstTokenTime = Date.now();
        if (delta.type === "text") {
          events.onText?.(delta.text);
          sawText = true;
        } else {
          events.onReasoning?.(delta.text);
        }
        break;
      case "tool_call_start":
        if (!firstTokenTime) firstTokenTime = Date.now();
        events.onTool?.(delta.toolCall);
        tools++;
        if (delta.toolCall.id) {
          toolStartTimes.set(delta.toolCall.id, Date.now());
        }
        break;
      case "tool_call_end": {
        // Providers emit a bare tool_call_end (no toolResult/toolSuccess) when
        // argument streaming finishes, before tool execution starts. Only
        // surface actual tool execution completions here.
        if (delta.toolSuccess === undefined && delta.toolResult === undefined) {
          break;
        }
        let measuredDuration: number | undefined;
        if (delta.toolCallId && toolStartTimes.has(delta.toolCallId)) {
          measuredDuration = Date.now() - toolStartTimes.get(delta.toolCallId)!;
          toolStartTimes.delete(delta.toolCallId);
        }
        const elapsed = delta.toolDurationMs ?? measuredDuration;
        if (elapsed !== undefined) {
          toolDurationMs += elapsed;
        }
        events.onToolResult?.({
          id: delta.toolCallId,
          name: delta.toolName,
          output: delta.toolResult ?? "",
          success: delta.toolSuccess ?? false,
          ...(delta.toolDurationMs !== undefined
            ? { durationMs: delta.toolDurationMs }
            : {}),
          ...(delta.exitCode !== undefined ? { exitCode: delta.exitCode } : {}),
          ...(delta.stderr !== undefined ? { stderr: delta.stderr } : {}),
          ...(delta.approval !== undefined ? { approval: delta.approval } : {}),
          ...(delta.fileEditDiff !== undefined
            ? { fileEditDiff: delta.fileEditDiff }
            : {}),
          ...(delta.testsSummary !== undefined
            ? { testsSummary: delta.testsSummary }
            : {}),
        });
        break;
      }
      case "error":
        streamError ??= delta.error;
        events.onError?.(delta.error);
        break;
      case "done":
        usage.inputTokens += delta.usage.inputTokens;
        usage.outputTokens += delta.usage.outputTokens;
        if (delta.usage.cachedInputTokens !== undefined) {
          usage.cachedInputTokens =
            (usage.cachedInputTokens ?? 0) + delta.usage.cachedInputTokens;
        }
        if (delta.usage.reasoningTokens !== undefined) {
          usage.reasoningTokens =
            (usage.reasoningTokens ?? 0) + delta.usage.reasoningTokens;
        }
        if (delta.usage.cacheReadTokens !== undefined) {
          usage.cacheReadTokens =
            (usage.cacheReadTokens ?? 0) + delta.usage.cacheReadTokens;
        }
        if (delta.usage.cacheWriteTokens !== undefined) {
          usage.cacheWriteTokens =
            (usage.cacheWriteTokens ?? 0) + delta.usage.cacheWriteTokens;
        }
        // Context window occupancy reflects the latest request, not the sum of
        // all iterations in a multi-tool turn.
        latestContextUsed = delta.usage.inputTokens + delta.usage.outputTokens;
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
      permissionProfile,
      onBeforeMutation,
      correlation,
      suppressToolNarration,
    } as import("../agent/agent-controller").ProcessMessageOptions);
    if (!sawText && result.text) events.onText?.(result.text);

    // Prefer actual executed provider/model metadata returned by processMessage
    // (accurate under SmartRouter & failover), falling back to getProvider().
    const maybeController = controller as unknown as {
      getProvider?: () => {
        name: string;
        modelInfo: () => {
          id?: string;
          name: string;
          contextWindow: number;
        };
      };
    };
    const providerObj = maybeController.getProvider?.();
    const model =
      result.actualModel ??
      (providerObj
        ? (providerObj.modelInfo().id ?? providerObj.modelInfo().name)
        : undefined);
    const providerName = result.actualProvider ?? providerObj?.name;
    const contextWindow =
      result.contextWindow ?? providerObj?.modelInfo().contextWindow ?? 0;
    const contextUsed = latestContextUsed;
    const contextRemaining = Math.max(0, contextWindow - contextUsed);
    const percentUsed =
      contextWindow > 0
        ? Math.min(100, Math.round((contextUsed / contextWindow) * 100))
        : 0;

    let costInfo: TurnCostInfo | undefined;
    if (providerName && model) {
      const quote = quoteCost(
        providerName,
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens ?? usage.cachedInputTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
      );
      costInfo = {
        usd: quote.usd,
        known: quote.known,
        pricingVersion: quote.pricingVersion,
        source: quote.source,
      };
    }

    const durationMs = Date.now() - startTime;
    const firstTokenMs = firstTokenTime
      ? firstTokenTime - startTime
      : undefined;

    events.onDone?.({
      tools,
      usage,
      durationMs,
      toolDurationMs,
      firstTokenMs,
      model,
      provider: providerName,
      cost: costInfo,
      context:
        contextWindow > 0
          ? {
              used: contextUsed,
              window: contextWindow,
              remaining: contextRemaining,
              percentUsed,
            }
          : undefined,
      ...(result.fallbacks !== undefined
        ? { fallbacks: result.fallbacks }
        : {}),
      ...(result.compactions !== undefined
        ? { compactions: result.compactions }
        : {}),
      runId: correlation.runId,
      sessionId: correlation.sessionId,
      turnId: correlation.turnId,
      traceId: correlation.traceContext?.traceId,
      spanId: correlation.traceContext?.spanId,
    });
    const outcome = {
      text: result.text,
      ...(streamError ? { error: streamError } : {}),
      aborted: abort.signal.aborted,
    };
    return { ...outcome, status: result.status ?? turnStatus(outcome) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = {
      text: "",
      error: streamError ?? message,
      aborted: abort.signal.aborted,
    };
    return { ...outcome, status: turnStatus(outcome) };
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
