/**
 * TDD (#114 AC 3): oversized tool output is truncated before it enters the
 * conversation history, keeping the head and the tail behind an explicit
 * marker. 100 KB is the shape that actually overflows a small local window.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOOL_OUTPUT_BUDGET_CHARS,
  truncateToolOutput,
} from "@/utils/tool-output-budget";

/** A 100 KB body whose bytes encode their position. */
function bigOutput(size = 100_000): string {
  return Array.from({ length: size }, (_, i) =>
    String.fromCharCode(97 + (i % 26)),
  ).join("");
}

describe("truncateToolOutput (#114)", () => {
  it("returns output that already fits untouched", () => {
    const small = "1: hello\n2: world\n";
    expect(truncateToolOutput(small)).toBe(small);
  });

  it("returns output exactly at the budget untouched", () => {
    const exact = "x".repeat(500);
    expect(truncateToolOutput(exact, 500)).toBe(exact);
  });

  it("truncates a 100 KB result to the budget with an explicit marker", () => {
    const output = bigOutput();
    const result = truncateToolOutput(output);

    expect(result.length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_BUDGET_CHARS);
    const match = /\n… \[(\d+) chars elided\]\n/.exec(result);
    expect(match).not.toBeNull();

    // Elided = original length minus everything that survived.
    const marker = match![0];
    const kept = result.length - marker.length;
    expect(Number(match![1])).toBe(output.length - kept);
    expect(Number(match![1])).toBeGreaterThan(90_000);
  });

  it("keeps the head and the tail of the original output", () => {
    const output = `HEAD${"m".repeat(99_000)}TAIL`;
    const result = truncateToolOutput(output, 2000);
    const [head, tail] = result.split(/\n… \[\d+ chars elided\]\n/);

    expect(head).toBe(output.slice(0, head.length));
    expect(head.startsWith("HEAD")).toBe(true);
    expect(tail).toBe(output.slice(output.length - tail.length));
    expect(tail.endsWith("TAIL")).toBe(true);
    expect(head.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
  });

  it("honours a small budget without exceeding it", () => {
    const result = truncateToolOutput(bigOutput(), 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toMatch(/… \[\d+ chars elided\]/);
  });

  it("still reports the elided size when the budget cannot hold the marker", () => {
    const output = "x".repeat(10_000);
    const result = truncateToolOutput(output, 5);
    expect(result).toMatch(/… \[\d+ chars elided\]/);
    expect(result).toContain(String(output.length));
  });
});
