/**
 * MetricsCollector: tracks latency, token usage, agent execution, tool calls,
 * and failures. Consumed by the status bar and observability panel.
 */

export interface RequestRecord {
  requestLatency: number; // time to first token
  totalLatency: number; // time to completion
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  model?: string;
  provider?: string;
  timestamp?: number;
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

export interface LatencyBucket {
  /** Upper bound in milliseconds, or Infinity for the unbounded bucket. */
  le: number;
  /** Cumulative count of requests with latency <= le. */
  count: number;
}

export interface LatencyDistribution {
  buckets: LatencyBucket[];
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export const DEFAULT_LATENCY_BUCKET_BOUNDS = [
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  30000,
  60000,
  Infinity,
] as const;

export interface Metrics {
  /** Total lifetime cumulative requests recorded since reset. */
  totalRequests: number;
  /** Total lifetime cumulative input tokens recorded across all requests. */
  totalTokensIn: number;
  /** Total lifetime cumulative output tokens recorded across all requests. */
  totalTokensOut: number;
  /** Cumulative input tokens (explicit alias for totalTokensIn). */
  cumulativeTokensIn: number;
  /** Cumulative output tokens (explicit alias for totalTokensOut). */
  cumulativeTokensOut: number;
  /** Rolling sum of input tokens across retained buffer (up to 1,000 recent requests). */
  rollingTokensIn: number;
  /** Rolling sum of output tokens across retained buffer (up to 1,000 recent requests). */
  rollingTokensOut: number;
  /** Number of request records retained in the rolling buffer. */
  retainedRequestCount: number;

  /**
   * Rolling-window average total latency over retained sample (max 1,000 recent requests).
   * Note: This reflects the retained window, NOT the lifetime average.
   */
  rollingAverageLatency: number;
  /**
   * Rolling-window average time to first token over retained sample.
   * Note: This reflects the retained window, NOT the lifetime average.
   */
  rollingAverageFirstTokenLatency: number;
  /** Lifetime average total latency across all requests ever recorded. */
  lifetimeAverageLatency: number;
  /** Lifetime average time to first token across all requests ever recorded. */
  lifetimeAverageFirstTokenLatency: number;

  /** Alias for rollingAverageLatency for backwards compatibility. */
  averageLatency: number;
  /** Alias for rollingAverageFirstTokenLatency for backwards compatibility. */
  averageFirstTokenLatency: number;

  /** Histogram-based distribution for total model request latency. */
  latencyHistogram: LatencyDistribution;
  /** Histogram-based distribution for time to first token (TTFT). */
  firstTokenLatencyHistogram: LatencyDistribution;

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
  tokens: {
    inputTokens: number;
    outputTokens: number;
  };
  recent: {
    requests: RequestRecord[];
    agentSteps: AgentStepLog[];
    toolCalls: ToolCallLog[];
    failures: string[];
    completionAcceptances: CompletionAcceptedLog[];
  };
}

interface HistogramState {
  counts: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
}

function createHistogramState(): HistogramState {
  return {
    counts: new Array(DEFAULT_LATENCY_BUCKET_BOUNDS.length).fill(0),
    count: 0,
    sum: 0,
    min: Infinity,
    max: 0,
  };
}

function recordToHistogram(state: HistogramState, val: number): void {
  const safeVal = Math.max(0, val);
  state.count++;
  state.sum += safeVal;
  if (safeVal < state.min) state.min = safeVal;
  if (safeVal > state.max) state.max = safeVal;
  for (let i = 0; i < DEFAULT_LATENCY_BUCKET_BOUNDS.length; i++) {
    if (safeVal <= DEFAULT_LATENCY_BUCKET_BOUNDS[i]) {
      state.counts[i]++;
    }
  }
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

function finalizeHistogram(
  state: HistogramState,
  sortedSample: number[],
): LatencyDistribution {
  const buckets: LatencyBucket[] = DEFAULT_LATENCY_BUCKET_BOUNDS.map((le, i) => ({
    le,
    count: state.counts[i],
  }));

  return {
    buckets,
    count: state.count,
    sum: state.sum,
    min: state.count > 0 ? state.min : 0,
    max: state.count > 0 ? state.max : 0,
    p50: computePercentile(sortedSample, 50),
    p90: computePercentile(sortedSample, 90),
    p95: computePercentile(sortedSample, 95),
    p99: computePercentile(sortedSample, 99),
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
  private tokenInCount = 0;
  private tokenOutCount = 0;
  private cumulativeTotalLatency = 0;
  private cumulativeFirstTokenLatency = 0;
  private agentStepCount = 0;
  private toolCallCount = 0;
  private failureCount = 0;
  private completionAcceptanceCount = 0;
  private sessionStartTime = Date.now();

  // Histogram trackers for lifetime latency distributions
  private totalLatencyHistogram = createHistogramState();
  private firstTokenLatencyHistogram = createHistogramState();

  /** Push onto a bounded ring: evict oldest once past the cap. */
  private pushBounded<T>(buffer: T[], item: T): void {
    buffer.push(item);
    if (buffer.length > METRICS_BUFFER_CAP) {
      buffer.shift();
    }
  }

  recordRequest(record: RequestRecord): void {
    const timestamped: RequestRecord = {
      timestamp: Date.now(),
      ...record,
    };
    this.pushBounded(this.requests, timestamped);
    this.requestCount++;
    this.tokenInCount += (record.inputTokens || 0);
    this.tokenOutCount += (record.outputTokens || 0);
    this.cumulativeTotalLatency += (record.totalLatency || 0);
    this.cumulativeFirstTokenLatency += (record.requestLatency || 0);

    recordToHistogram(this.totalLatencyHistogram, record.totalLatency || 0);
    recordToHistogram(
      this.firstTokenLatencyHistogram,
      record.requestLatency || 0,
    );
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
      tokens: {
        inputTokens: this.tokenInCount,
        outputTokens: this.tokenOutCount,
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
    const retainedTotalLatency = this.requests.reduce(
      (sum, r) => sum + r.totalLatency,
      0,
    );
    const retainedFirstToken = this.requests.reduce(
      (sum, r) => sum + r.requestLatency,
      0,
    );
    const retainedTokensIn = this.requests.reduce(
      (sum, r) => sum + r.inputTokens,
      0,
    );
    const retainedTokensOut = this.requests.reduce(
      (sum, r) => sum + r.outputTokens,
      0,
    );
    const retainedCount = this.requests.length;

    const rollingAvgLatency =
      retainedCount > 0 ? retainedTotalLatency / retainedCount : 0;
    const rollingAvgFirstToken =
      retainedCount > 0 ? retainedFirstToken / retainedCount : 0;

    const lifetimeAvgLatency =
      this.requestCount > 0 ? this.cumulativeTotalLatency / this.requestCount : 0;
    const lifetimeAvgFirstToken =
      this.requestCount > 0
        ? this.cumulativeFirstTokenLatency / this.requestCount
        : 0;

    const sortedTotalLatencies = this.requests
      .map((r) => r.totalLatency)
      .sort((a, b) => a - b);
    const sortedFirstTokenLatencies = this.requests
      .map((r) => r.requestLatency)
      .sort((a, b) => a - b);

    return {
      totalRequests: this.requestCount,
      totalTokensIn: this.tokenInCount,
      totalTokensOut: this.tokenOutCount,
      cumulativeTokensIn: this.tokenInCount,
      cumulativeTokensOut: this.tokenOutCount,
      rollingTokensIn: retainedTokensIn,
      rollingTokensOut: retainedTokensOut,
      retainedRequestCount: retainedCount,

      rollingAverageLatency: rollingAvgLatency,
      rollingAverageFirstTokenLatency: rollingAvgFirstToken,
      lifetimeAverageLatency: lifetimeAvgLatency,
      lifetimeAverageFirstTokenLatency: lifetimeAvgFirstToken,

      averageLatency: rollingAvgLatency,
      averageFirstTokenLatency: rollingAvgFirstToken,

      latencyHistogram: finalizeHistogram(
        this.totalLatencyHistogram,
        sortedTotalLatencies,
      ),
      firstTokenLatencyHistogram: finalizeHistogram(
        this.firstTokenLatencyHistogram,
        sortedFirstTokenLatencies,
      ),

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
    this.tokenInCount = 0;
    this.tokenOutCount = 0;
    this.cumulativeTotalLatency = 0;
    this.cumulativeFirstTokenLatency = 0;
    this.totalLatencyHistogram = createHistogramState();
    this.firstTokenLatencyHistogram = createHistogramState();
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
