/**
 * Structured JSONL event protocol for machine-readable CLI runs.
 *
 * `--json` makes stdout carry one JSON object per line and nothing else.
 * Diagnostics stay on stderr. The protocol is versioned so consumers can
 * reject unknown shapes without guessing.
 */
import type { TurnStatus } from "./turn-runtime";

export const JSONL_PROTOCOL_VERSION = 1 as const;

interface EventMeta {
  v: typeof JSONL_PROTOCOL_VERSION;
  /** UTC ISO-8601 timestamp; frontends convert for display. */
  at: string;
}

export type JsonlEvent =
  | (EventMeta & {
      type: "session.started";
      workspace: string;
      sessionId?: string;
      model?: string;
      mode: string;
    })
  | (EventMeta & { type: "message.delta"; text: string })
  | (EventMeta & {
      type: "message.completed";
      text: string;
      status: TurnStatus;
    })
  | (EventMeta & {
      type: "tool.started";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    })
  | (EventMeta & {
      type: "tool.completed";
      id: string;
      name: string;
      output: string;
    })
  | (EventMeta & {
      type: "tool.failed";
      id: string;
      name: string;
      output: string;
    })
  | (EventMeta & { type: "approval.required"; description: string })
  | (EventMeta & { type: "agent.status"; status: TurnStatus })
  | (EventMeta & {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
    })
  | (EventMeta & { type: "error"; message: string })
  | (EventMeta & { type: "session.completed"; status: TurnStatus });

type WithoutMeta<T> = T extends JsonlEvent ? Omit<T, keyof EventMeta> : never;

/** An event before the protocol version and timestamp are attached. */
export type JsonlEventInput = WithoutMeta<JsonlEvent>;

export type JsonlEventType = JsonlEvent["type"];

export interface SessionStartedInfo {
  workspace: string;
  sessionId?: string;
  model?: string;
  mode: string;
}

/** Emit protocol events to a line-oriented sink (stdout by default). */
export class JsonlEventSink {
  private started = false;

  constructor(
    private readonly write: (line: string) => void = (line) =>
      process.stdout.write(line),
  ) {}

  emit(input: JsonlEventInput): void {
    const event = {
      ...input,
      v: JSONL_PROTOCOL_VERSION,
      at: new Date().toISOString(),
    } as JsonlEvent;
    this.write(`${JSON.stringify(event)}\n`);
  }

  /** `session.started` is emitted once per CLI process. */
  startSession(info: SessionStartedInfo): void {
    if (this.started) return;
    this.started = true;
    this.emit({ type: "session.started", ...info });
  }

  completeSession(status: TurnStatus): void {
    this.emit({ type: "session.completed", status });
  }
}

/** Parse one stdout line; throws on unknown protocol versions. */
export function parseJsonlEvent(line: string): JsonlEvent {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { v?: unknown }).v !== JSONL_PROTOCOL_VERSION
  ) {
    throw new Error("unsupported JSONL event protocol version");
  }
  return value as JsonlEvent;
}
