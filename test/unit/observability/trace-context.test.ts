/**
 * Dependency-free W3C trace context so logs and audit entries can be
 * correlated with spans (OTel-compatible traceparent format).
 */
import { describe, it, expect } from "vitest";
import {
  createTraceContext,
  withSpan,
  extractTraceContext,
  createRunId,
  createTurnId,
  createProviderRequestId,
  createRoutingDecisionId,
  createCompactionId,
  createToolCallId,
  createMcpRequestId,
  createRetrievalQueryId,
  createExecutionCorrelation,
  type TraceContext,
} from "@/observability/trace-context";

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

describe("trace context", () => {
  it("creates a valid W3C traceparent", () => {
    const ctx = createTraceContext();
    expect(ctx.traceparent).toMatch(TRACEPARENT);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("creates child spans that keep the trace id but change the span id", () => {
    const parent = createTraceContext();
    const child = withSpan(parent, "tool.execute");
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.traceparent).toMatch(TRACEPARENT);
  });

  it("round-trips through a traceparent header", () => {
    const original = createTraceContext();
    const extracted = extractTraceContext(original.traceparent);
    expect(extracted?.traceId).toBe(original.traceId);
    expect(extracted?.spanId).toBe(original.spanId);
  });

  it("rejects malformed or all-zero headers instead of trusting them", () => {
    expect(extractTraceContext("garbage")).toBeNull();
    expect(
      extractTraceContext(
        "00-00000000000000000000000000000000-0000000000000000-01",
      ),
    ).toBeNull();
  });

  it("supports a parent context supplied explicitly", () => {
    const parent: TraceContext = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    };
    expect(withSpan(parent, "child").traceId).toBe(parent.traceId);
  });

  describe("ExecutionCorrelation and ID generators", () => {
    it("generates correctly formatted hierarchical identifiers", () => {
      expect(createRunId()).toMatch(/^run-[0-9a-f]{16}$/);
      expect(createTurnId()).toMatch(/^turn-[0-9a-f]{12}$/);
      expect(createProviderRequestId()).toMatch(/^req-[0-9a-f]{12}$/);
      expect(createRoutingDecisionId()).toMatch(/^route-[0-9a-f]{12}$/);
      expect(createCompactionId()).toMatch(/^compact-[0-9a-f]{12}$/);
      expect(createToolCallId()).toMatch(/^tool-[0-9a-f]{12}$/);
      expect(createMcpRequestId()).toMatch(/^mcp-[0-9a-f]{12}$/);
      expect(createRetrievalQueryId()).toMatch(/^retrieval-[0-9a-f]{12}$/);
    });

    it("creates an execution correlation context with generated defaults", () => {
      const corr = createExecutionCorrelation();
      expect(corr.runId).toMatch(/^run-[0-9a-f]{16}$/);
      expect(corr.sessionId).toMatch(/^sess-[0-9a-f]{12}$/);
      expect(corr.turnId).toMatch(/^turn-[0-9a-f]{12}$/);
      expect(corr.traceContext?.traceparent).toMatch(TRACEPARENT);
    });

    it("preserves explicit parameters in execution correlation", () => {
      const customTrace = createTraceContext();
      const corr = createExecutionCorrelation({
        runId: "run-custom-1",
        sessionId: "session-abc",
        turnId: "turn-123",
        toolCallId: "tool-456",
        providerRequestId: "req-789",
        traceContext: customTrace,
      });

      expect(corr.runId).toBe("run-custom-1");
      expect(corr.sessionId).toBe("session-abc");
      expect(corr.turnId).toBe("turn-123");
      expect(corr.toolCallId).toBe("tool-456");
      expect(corr.providerRequestId).toBe("req-789");
      expect(corr.traceContext).toBe(customTrace);
    });
  });
});
