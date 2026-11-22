/**
 * Minimal W3C Trace Context implementation (no external dependencies).
 *
 * Produces standards-compliant `traceparent` headers that any OTel collector
 * understands, so audit entries and structured logs can carry the same
 * `trace_id` as provider/tool spans without pulling in the full OTel SDK.
 */
import { randomBytes } from "crypto";

export interface TraceContext {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters. */
  spanId: string;
  /** W3C traceparent header: 00-<traceId>-<spanId>-01 */
  traceparent: string;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function make(traceId: string, spanId: string): TraceContext {
  return {
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

/** Start a new root trace. */
export function createTraceContext(): TraceContext {
  return make(hex(16), hex(8));
}

/** Create a child span under an existing trace. */
export function withSpan(parent: TraceContext, _name: string): TraceContext {
  return make(parent.traceId, hex(8));
}

/** Parse a traceparent header; returns null for invalid/all-zero values. */
export function extractTraceContext(
  header: string | undefined,
): TraceContext | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;
  const [, traceId, spanId] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  // The sampled flag does not affect correlation, so both 00 and 01 are
  // accepted; the regex has already rejected malformed/reserved values.
  return make(traceId, spanId);
}
