/**
 * MetricsCollector: tracks latency, token usage, agent execution, tool calls,
 * and failures. Consumed by the status bar and observability panel.
 */

export interface RequestRecord {
  requestLatency: number; // time to first token
  totalLatency: number; // time to completion
  inputTokens: number;
  outputTokens: number;
}

export interface AgentStepLog {
  agentName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  input: string;
  output: string;
  success: boolean;
  error?: string;
}

export interface ToolCallLog {
  toolName: string;
  startTime: number;
  durationMs: number;
  success: boolean;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
}

export interface CompletionAcceptedLog {
  model: string;
  length: number;
  timestamp: number;
}

export interface Metrics {
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  averageLatency: number;
  averageFirstTokenLatency: number;
  agentSteps: AgentStepLog[];
  toolCalls: ToolCallLog[];
  failures: string[];
  totalFailures: number;
  sessionStartTime: number;
  /** Inline completion acceptances — used as quality signal for SmartRouter. */
  completionAcceptances: CompletionAcceptedLog[];
}

/** Cap on how many recent entries each buffer retains (oldest evicted). */
export const METRICS_BUFFER_CAP = 1000;

export interface MetricsTotals {
  requests: number;
  agentSteps: number;
  toolCalls: number;
  failures: number;
  completionAcceptances: number;
}

export interface MetricsSnapshot {
  totals: MetricsTotals;
  recent: {
    requests: RequestRecord[];
    agentSteps: AgentStepLog[];
    toolCalls: ToolCallLog[];
    failures: string[];
    completionAcceptances: CompletionAcceptedLog[];
  };
}

export class MetricsCollector {
  private requests: RequestRecord[] = [];
  private agentSteps: AgentStepLog[] = [];
  private toolCalls: ToolCallLog[] = [];
  private failures: string[] = [];
  private completionAcceptances: CompletionAcceptedLog[] = [];
  // Cumulative counters — survive buffer eviction so totals stay accurate
  private requestCount = 0;
  private agentStepCount = 0;
  private toolCallCount = 0;
  private failureCount = 0;
  private completionAcceptanceCount = 0;
  private sessionStartTime = Date.now();

  /** Push onto a bounded ring: evict oldest once past the cap. */
  private pushBounded<T>(buffer: T[], item: T): void {
    buffer.push(item);
    if (buffer.length > METRICS_BUFFER_CAP) {
      buffer.shift();
    }
  }

  recordRequest(record: RequestRecord): void {
    this.pushBounded(this.requests, record);
    this.requestCount++;
  }

  recordAgentStep(step: AgentStepLog): void {
    this.pushBounded(this.agentSteps, step);
    this.agentStepCount++;
  }

  recordToolCall(log: ToolCallLog): void {
    this.pushBounded(this.toolCalls, log);
    this.toolCallCount++;
  }

  recordFailure(message: string): void {
    this.pushBounded(this.failures, message);
    this.failureCount++;
  }

  /**
   * Record that the user accepted an inline completion.
   * Feeds back into SmartRouter's model quality signal over time.
   */
  recordCompletionAccepted(model: string, length: number): void {
    this.pushBounded(this.completionAcceptances, {
      model,
      length,
      timestamp: Date.now(),
    });
    this.completionAcceptanceCount++;
  }

  /**
   * Cumulative totals since last reset, plus bounded recent buffers.
   * Totals remain accurate even after oldest entries are evicted.
   */
  snapshot(): MetricsSnapshot {
    return {
      totals: {
        requests: this.requestCount,
        agentSteps: this.agentStepCount,
        toolCalls: this.toolCallCount,
        failures: this.failureCount,
        completionAcceptances: this.completionAcceptanceCount,
      },
      recent: {
        requests: [...this.requests],
        agentSteps: [...this.agentSteps],
        toolCalls: [...this.toolCalls],
        failures: [...this.failures],
        completionAcceptances: [...this.completionAcceptances],
      },
    };
  }

  getMetrics(): Metrics {
    const totalLatency = this.requests.reduce(
      (sum, r) => sum + r.totalLatency,
      0,
    );
    const totalFirstToken = this.requests.reduce(
      (sum, r) => sum + r.requestLatency,
      0,
    );
    const count = this.requests.length;

    return {
      totalRequests: this.requestCount,
      totalTokensIn: this.requests.reduce((sum, r) => sum + r.inputTokens, 0),
      totalTokensOut: this.requests.reduce((sum, r) => sum + r.outputTokens, 0),
      averageLatency: count > 0 ? totalLatency / count : 0,
      averageFirstTokenLatency: count > 0 ? totalFirstToken / count : 0,
      agentSteps: [...this.agentSteps],
      toolCalls: [...this.toolCalls],
      failures: [...this.failures],
      totalFailures: this.failureCount,
      sessionStartTime: this.sessionStartTime,
      completionAcceptances: [...this.completionAcceptances],
    };
  }

  reset(): void {
    this.requests = [];
    this.agentSteps = [];
    this.toolCalls = [];
    this.failures = [];
    this.completionAcceptances = [];
    this.requestCount = 0;
    this.agentStepCount = 0;
    this.toolCallCount = 0;
    this.failureCount = 0;
    this.completionAcceptanceCount = 0;
    this.sessionStartTime = Date.now();
  }

  toJSON(): string {
    return JSON.stringify(this.getMetrics(), null, 2);
  }
}
