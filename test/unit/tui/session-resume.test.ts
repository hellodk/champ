import { describe, expect, it } from "vitest";
import { reconstructTurnsFromHistory } from "@/tui/session-resume";
import type { LLMMessage } from "@/providers/types";

describe("reconstructTurnsFromHistory (#212)", () => {
  it("groups user prompts, assistant prose, native tool calls and tool results into turns", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "Fix auth" },
      {
        role: "assistant",
        content: "Checking auth.ts.",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: { path: "src/auth.ts" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "c1",
        content: [
          { type: "tool_result", toolUseId: "c1", content: "const x = 1;" },
        ],
      },
      { role: "assistant", content: "Fixed the auth logic." },
    ];

    const { turns, toolRecords } = reconstructTurnsFromHistory(history);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe("Fix auth");
    expect(turns[0].items.map((item) => item.kind)).toEqual([
      "assistant_text",
      "activity_group",
      "assistant_text",
    ]);
    expect(toolRecords.c1?.start.name).toBe("read_file");
    expect(toolRecords.c1?.result?.output).toContain("const x = 1;");
  });

  it("pairs prompt-based <tool_result> user messages without creating fake user turns", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "Check files" },
      {
        role: "assistant",
        content: "Inspecting.",
        toolCalls: [
          { id: "p1", name: "list_directory", arguments: { path: "." } },
        ],
      },
      {
        role: "user",
        content:
          '<tool_result tool="list_directory" status="success">\nsrc/\n</tool_result>',
      },
      { role: "assistant", content: "Found src/." },
    ];

    const { turns, toolRecords } = reconstructTurnsFromHistory(history);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe("Check files");
    expect(toolRecords.p1?.result?.success).toBe(true);
    expect(toolRecords.p1?.result?.output).toContain("src/");
  });
});
