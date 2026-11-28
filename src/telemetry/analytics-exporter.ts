import { EventBuffer } from "./event-buffer";
import type { TelemetryConfig } from "../config/config-loader";
import type { AgentRunReport } from "../agent-manager/types";

export interface TelemetrySpanAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: number }
    | { boolValue: boolean }
    | { doubleValue: number };
}

export interface TelemetrySpan {
  traceId?: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number; // 1 = INTERNAL, 3 = CLIENT
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: TelemetrySpanAttribute[];
  status?: { code: number; message?: string };
}

export interface TelemetryEvent {
  runId: string;
  timestamp: string;
  userId: string;
  userEmail?: string;
  sessionId: string;
  workspaceId: string;
  extensionVersion: string;
  report: AgentRunReport;
  spans?: TelemetrySpan[];
}

const DEFAULT_BUFFER_EVENTS = 1_000;
const DEFAULT_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 300_000];

export class AnalyticsExporter {
  private readonly buffer: EventBuffer<TelemetryEvent>;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: TelemetryConfig,
    public readonly userId: string,
    public readonly workspaceId: string,
  ) {
    this.buffer = new EventBuffer<TelemetryEvent>(
      config.bufferMaxEvents ?? DEFAULT_BUFFER_EVENTS,
      config.bufferMaxBytes ?? DEFAULT_BUFFER_BYTES,
    );
  }

  async export(event: TelemetryEvent): Promise<void> {
    const success = await this.send([event]);
    if (!success) {
      this.buffer.push(event);
      this.scheduleRetry();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.size() === 0) return;
    const events = this.buffer.drain();
    const success = await this.send(events);
    if (!success) {
      events.forEach((e) => this.buffer.push(e));
    } else {
      this.retryAttempt = 0;
      this.clearRetryTimer();
    }
  }

  bufferedCount(): number {
    return this.buffer.size();
  }

  dispose(): void {
    this.clearRetryTimer();
  }

  private async send(events: TelemetryEvent[]): Promise<boolean> {
    const {
      endpoint,
      format = "otlp",
      headers = {},
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = this.config;
    const body =
      format === "otlp" ? this.toOtlpPayload(events) : JSON.stringify(events);
    const contentType = "application/json";

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": contentType, ...headers },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  private toOtlpPayload(events: TelemetryEvent[]): string {
    const allSpans: Array<Record<string, unknown>> = [];

    for (const ev of events) {
      const traceId = ev.runId.replace(/-/g, "").padEnd(32, "0");
      const rootSpanId = ev.runId
        .replace(/-/g, "")
        .slice(0, 16)
        .padEnd(16, "0");

      allSpans.push({
        traceId,
        spanId: rootSpanId,
        name: "champ.agent_run",
        kind: 3, // CLIENT
        startTimeUnixNano: String(new Date(ev.timestamp).getTime() * 1_000_000),
        endTimeUnixNano: String(
          (new Date(ev.timestamp).getTime() + ev.report.totalDurationMs) *
            1_000_000,
        ),
        attributes: [
          { key: "user.id", value: { stringValue: ev.userId } },
          { key: "session.id", value: { stringValue: ev.sessionId } },
          { key: "workspace.id", value: { stringValue: ev.workspaceId } },
          {
            key: "extension.version",
            value: { stringValue: ev.extensionVersion },
          },
          {
            key: "tokens.input",
            value: { intValue: ev.report.totalInputTokens },
          },
          {
            key: "tokens.output",
            value: { intValue: ev.report.totalOutputTokens },
          },
          { key: "run.success", value: { boolValue: ev.report.success } },
          {
            key: "run.duration_ms",
            value: { intValue: ev.report.totalDurationMs },
          },
          ...(ev.userEmail && this.config.includeUserIdentity === true
            ? [{ key: "user.email", value: { stringValue: ev.userEmail } }]
            : []),
        ],
        status: { code: ev.report.success ? 1 : 2 },
      });

      if (ev.spans && ev.spans.length > 0) {
        for (const span of ev.spans) {
          allSpans.push({
            traceId: span.traceId ?? traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId ?? rootSpanId,
            name: span.name,
            kind: span.kind ?? 1,
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
            attributes: span.attributes,
            status: span.status ?? { code: 1 },
          });
        }
      }
    }

    return JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "champ-vscode" } },
              {
                key: "service.version",
                value: { stringValue: events[0]?.extensionVersion ?? "" },
              },
            ],
          },
          scopeSpans: [{ spans: allSpans }],
        },
      ],
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return; // already scheduled
    const delayMs =
      RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)];
    this.retryAttempt++;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      await this.flush();
      if (this.buffer.size() > 0) {
        this.scheduleRetry(); // still failing — schedule again
      }
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
