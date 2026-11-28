import { describe, expect, it } from "vitest";
import {
  redactToolText,
  toolDetailLines,
  toolSummary,
  type ToolRecord,
} from "@/tui/tool-events";

const record: ToolRecord = {
  start: {
    id: "t1",
    name: "read_file",
    args: '{"path":"/repo/a.ts","token":"sk-abcdefghijklmnop"}',
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  result: {
    id: "t1",
    name: "read_file",
    success: true,
    output: "line one\nline two\nline three".repeat(20),
    stderr: "warning: deprecated",
    exitCode: 0,
    durationMs: 321,
    approval: "approved",
  },
};

describe("structured tool events", () => {
  it("redacts credentials from arguments and output", () => {
    expect(redactToolText("Bearer abcdefghijklmnop")).toContain("[redacted]");
    expect(redactToolText("api_key=sk-abcdefghijklmnop")).not.toContain(
      "sk-abcdef",
    );
    expect(redactToolText("password: hunter2")).toContain("[redacted]");
  });

  it("retains full output in the record while the summary stays short", () => {
    expect(record.result?.output.length).toBeGreaterThan(80);
    expect(toolSummary(record, 80).length).toBeLessThanOrEqual(80);
    expect(toolSummary(record, 80)).not.toContain("line three".repeat(3));
  });

  it("exposes stderr, exit code, duration, approval and redacted arguments", () => {
    const detail = Object.fromEntries(
      toolDetailLines(record).map((line) => [line.label, line.value]),
    );
    expect(detail.stderr).toBe("warning: deprecated");
    expect(detail["exit code"]).toBe("0");
    expect(detail.duration).toBe("321ms");
    expect(detail.approval).toBe("approved");
    expect(detail.arguments).not.toContain("sk-abcdef");
  });

  it("reports errors from a failed tool", () => {
    const failed: ToolRecord = {
      ...record,
      result: {
        ...record.result!,
        success: false,
        error: "ENOENT",
        output: "",
      },
    };
    const detail = Object.fromEntries(
      toolDetailLines(failed).map((line) => [line.label, line.value]),
    );
    expect(detail.error).toBe("ENOENT");
  });
});
