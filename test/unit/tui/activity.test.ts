import { describe, expect, it } from "vitest";
import {
  categorizeTool,
  DEFAULT_TRANSCRIPT_CONFIG,
  extractToolTarget,
  formatActivityStep,
  formatTurnFooter,
  nextVerbosity,
  shortModelName,
  summarizeActivityGroup,
  type ActivityEntry,
  type ActivityGroup,
} from "@/tui/activity";
import type { ToolRecord } from "@/tui/tool-events";

function toolEntry(
  id: string,
  name: string,
  status: ActivityEntry["status"] = "done",
  durationMs = 10,
): ActivityEntry {
  return {
    id,
    kind: "tool",
    category: categorizeTool(name),
    toolId: id,
    toolName: name,
    startedAt: "2026-11-28T12:00:00.000Z",
    finishedAt: status === "running" ? undefined : "2026-11-28T12:00:00.010Z",
    durationMs,
    status,
  };
}

describe("activity categorization and formatting", () => {
  it("categorizes all Champ built-in tools and MCP tools accurately", () => {
    expect(categorizeTool("read_file")).toBe("read");
    expect(categorizeTool("list_directory")).toBe("read");
    expect(categorizeTool("grep_search")).toBe("search");
    expect(categorizeTool("file_search")).toBe("search");
    expect(categorizeTool("codebase_search")).toBe("search");
    expect(categorizeTool("edit_file")).toBe("edit");
    expect(categorizeTool("create_file")).toBe("edit");
    expect(categorizeTool("delete_file")).toBe("edit");
    expect(categorizeTool("generate_doc")).toBe("edit");
    expect(categorizeTool("generate_diagram")).toBe("edit");
    expect(categorizeTool("run_terminal_cmd")).toBe("command");
    expect(categorizeTool("run_tests")).toBe("test");
    expect(categorizeTool("git")).toBe("git");
    expect(categorizeTool("web_search")).toBe("web");
    expect(categorizeTool("fetch_url")).toBe("web");
    expect(categorizeTool("browser")).toBe("web");
    expect(categorizeTool("delegate_task")).toBe("delegate");
    expect(categorizeTool("mcp_github_list_prs")).toBe("mcp");
  });

  it("extracts concise redacted targets from tool arguments", () => {
    expect(
      extractToolTarget("read_file", JSON.stringify({ path: "src/auth.ts" })),
    ).toBe("src/auth.ts");
    expect(
      extractToolTarget(
        "read_file",
        JSON.stringify({ path: "src/auth.ts", startLine: 10, endLine: 40 }),
      ),
    ).toBe("src/auth.ts:10-40");
    expect(
      extractToolTarget(
        "run_terminal_cmd",
        JSON.stringify({
          command: "curl -H 'Bearer secret12345678' https://x",
        }),
      ),
    ).not.toContain("secret12345678");
    expect(
      extractToolTarget(
        "grep_search",
        JSON.stringify({ query: "expired_token" }),
      ),
    ).toBe('"expired_token"');
  });

  it("summarizes grouped activities in natural execution categories", () => {
    const toolRecords: Record<string, ToolRecord> = {
      t1: {
        start: { id: "t1", name: "read_file", args: '{"path":"src/a.ts"}' },
        result: {
          id: "t1",
          name: "read_file",
          output: "ok",
          success: true,
          durationMs: 12,
        },
      },
      t2: {
        start: { id: "t2", name: "read_file", args: '{"path":"src/b.ts"}' },
        result: {
          id: "t2",
          name: "read_file",
          output: "ok",
          success: true,
          durationMs: 8,
        },
      },
      t3: {
        start: { id: "t3", name: "grep_search", args: '{"query":"auth"}' },
        result: {
          id: "t3",
          name: "grep_search",
          output: "ok",
          success: true,
          durationMs: 20,
        },
      },
      t4: {
        start: { id: "t4", name: "edit_file", args: '{"path":"src/a.ts"}' },
        result: {
          id: "t4",
          name: "edit_file",
          output: "ok",
          success: true,
          durationMs: 5,
        },
      },
      t5: {
        start: {
          id: "t5",
          name: "run_terminal_cmd",
          args: '{"command":"pnpm test"}',
        },
        result: {
          id: "t5",
          name: "run_terminal_cmd",
          output: "ok",
          success: true,
          exitCode: 0,
          durationMs: 800,
        },
      },
      t6: {
        start: { id: "t6", name: "run_tests", args: "{}" },
        result: {
          id: "t6",
          name: "run_tests",
          output: "PASSED",
          success: true,
          durationMs: 400,
          testsSummary: { passed: 14, failed: 0, skipped: 0 },
        },
      },
    };
    const group: ActivityGroup = {
      id: "g1",
      entries: [
        toolEntry("t1", "read_file", "done", 12),
        toolEntry("t2", "read_file", "done", 8),
        toolEntry("t3", "grep_search", "done", 20),
        toolEntry("t4", "edit_file", "done", 5),
        toolEntry("t5", "run_terminal_cmd", "done", 800),
        toolEntry("t6", "run_tests", "done", 400),
      ],
    };

    const summary = summarizeActivityGroup(group, toolRecords);
    expect(summary.summary).toContain("Explored 2 files");
    expect(summary.summary).toContain("Searched 1 time");
    expect(summary.summary).toContain("Edited 1 file");
    expect(summary.summary).toContain("Ran 1 command");
    expect(summary.testHighlight).toEqual({
      passed: true,
      text: "✓ Tests passed (14)",
    });
    expect(summary.failedCount).toBe(0);
    expect(summary.totalCount).toBe(6);
  });

  it("shows live running progress and failed count when tools fail", () => {
    const toolRecords: Record<string, ToolRecord> = {
      t1: {
        start: {
          id: "t1",
          name: "run_terminal_cmd",
          args: '{"command":"pnpm test"}',
        },
        result: {
          id: "t1",
          name: "run_terminal_cmd",
          output: "fail",
          success: false,
          exitCode: 1,
          durationMs: 500,
        },
      },
      t2: {
        start: { id: "t2", name: "read_file", args: '{"path":"src/token.ts"}' },
      },
    };
    const group: ActivityGroup = {
      id: "g2",
      entries: [
        toolEntry("t1", "run_terminal_cmd", "failed", 500),
        toolEntry("t2", "read_file", "running", 0),
      ],
    };

    const summary = summarizeActivityGroup(group, toolRecords);
    expect(summary.failedCount).toBe(1);
    expect(summary.runningLabel).toBe("Reading src/token.ts…");

    const step = formatActivityStep(group.entries[0], toolRecords);
    expect(step.icon).toBe("✗");
    expect(step.label).toContain("Run pnpm test");
    expect(step.meta).toContain("exit 1");
  });

  it("shortens local GGUF paths, org prefixes, and HF cache paths into clean model names", () => {
    expect(shortModelName("/home/dk/models/Qwen3-4B-Q4_K_M.gguf")).toBe(
      "Qwen3-4B-Q4_K_M",
    );
    expect(shortModelName("mlx-community/Qwen3.5-4B-MLX-4bit")).toBe(
      "Qwen3.5-4B-MLX-4bit",
    );
    expect(shortModelName("/cache/models--Qwen--Qwen3-Coder-30B")).toBe(
      "Qwen3-Coder-30B",
    );
    expect(shortModelName("claude-sonnet-4-20250514")).toBe(
      "claude-sonnet-4-20250514",
    );
  });

  it("formats compact turn footers without zero-tool noise or fake $0 cost", () => {
    const localSimple = formatTurnFooter(
      {
        tools: 0,
        inputTokens: 5800,
        outputTokens: 400,
        durationMs: 7100,
        contextUsed: 6200,
        contextWindow: 32768,
        contextPercent: 19,
        costUsd: 0,
        costKnown: true,
        costSource: "local",
        model: "/home/dk/models/Qwen3-4B-Q4_K_M.gguf",
      },
      DEFAULT_TRANSCRIPT_CONFIG,
      "completed",
    );
    expect(localSimple).toBe(
      "7.1s · 6.2k tokens · 19% context · Qwen3-4B-Q4_K_M",
    );
    expect(localSimple).not.toContain("tools");
    expect(localSimple).not.toContain("$0");

    const unknownCostCloud = formatTurnFooter(
      {
        tools: 3,
        inputTokens: 2000,
        outputTokens: 500,
        durationMs: 4200,
        costUsd: null,
        costKnown: false,
        costSource: "unknown",
        model: "custom-model",
      },
      DEFAULT_TRANSCRIPT_CONFIG,
      "completed",
    );
    expect(unknownCostCloud).toBe(
      "4.2s · 2.5k tokens · 3 tools · custom-model",
    );
    expect(unknownCostCloud).not.toContain("$0");

    const highVerbosity = formatTurnFooter(
      {
        tools: 3,
        inputTokens: 2000,
        outputTokens: 500,
        durationMs: 4200,
        firstTokenMs: 310,
        costUsd: null,
        costKnown: false,
        costSource: "unknown",
        pricingVersion: "2026-11-01",
        model: "/home/dk/models/custom.gguf",
      },
      { ...DEFAULT_TRANSCRIPT_CONFIG, verbosity: "high" },
      "completed",
    );
    expect(highVerbosity).toContain("cost=unknown");
    expect(highVerbosity).toContain("in=2000");
    expect(highVerbosity).toContain("out=500");
    expect(highVerbosity).toContain("TTFT=310ms");
  });

  it("cycles verbosity low -> medium -> high -> low", () => {
    expect(nextVerbosity("low")).toBe("medium");
    expect(nextVerbosity("medium")).toBe("high");
    expect(nextVerbosity("high")).toBe("low");
  });
});
