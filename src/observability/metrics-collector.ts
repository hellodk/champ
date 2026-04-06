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
}

export class MetricsCollector {
  private requests: RequestRecord[] = [];
  private agentSteps: AgentStepLog[] = [];
  private toolCalls: ToolCallLog[] = [];
  private failures: string[] = [];
  private sessionStartTime = Date.now();

  recordRequest(record: RequestRecord): void {
    this.requests.push(record);
  }

  recordAgentStep(step: AgentStepLog): void {
    this.agentSteps.push(step);
  }

  recordToolCall(log: ToolCallLog): void {
    this.toolCalls.push(log);
  }

  recordFailure(message: string): void {
    this.failures.push(message);
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
      totalRequests: count,
      totalTokensIn: this.requests.reduce((sum, r) => sum + r.inputTokens, 0),
      totalTokensOut: this.requests.reduce((sum, r) => sum + r.outputTokens, 0),
      averageLatency: count > 0 ? totalLatency / count : 0,
      averageFirstTokenLatency: count > 0 ? totalFirstToken / count : 0,
      agentSteps: [...this.agentSteps],
      toolCalls: [...this.toolCalls],
      failures: [...this.failures],
      totalFailures: this.failures.length,
      sessionStartTime: this.sessionStartTime,
    };
  }

  reset(): void {
    this.requests = [];
    this.agentSteps = [];
    this.toolCalls = [];
    this.failures = [];
    this.sessionStartTime = Date.now();
  }

  toJSON(): string {
    return JSON.stringify(this.getMetrics(), null, 2);
  }
}
