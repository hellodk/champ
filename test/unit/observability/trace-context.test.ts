/**
 * Dependency-free W3C trace context so logs and audit entries can be
 * correlated with spans (OTel-compatible traceparent format).
 */
import { describe, it, expect } from "vitest";
import {
  createTraceContext,
  withSpan,
  extractTraceContext,
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
});
