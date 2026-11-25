import { describe, expect, it } from "vitest";
import {
  formatHistoryPage,
  formatSessionPage,
  toHistoryLines,
} from "@/cli/history-report";

const messages = [
  { role: "user", content: "fix the parser bug" },
  { role: "assistant", content: "I will inspect markdown tokens" },
  { role: "tool", content: "ignored" },
  { role: "user", content: "also update tests" },
];

describe("REPL history paging (#194)", () => {
  it("numbers only user and assistant turns on single lines", () => {
    expect(toHistoryLines(messages)).toEqual([
      { number: 1, role: "user", text: "fix the parser bug" },
      { number: 2, role: "assistant", text: "I will inspect markdown tokens" },
      { number: 3, role: "user", text: "also update tests" },
    ]);
  });

  it("filters case-insensitively and clamps the requested page", () => {
    const lines = toHistoryLines(messages);
    const page = formatHistoryPage(lines, {
      query: "MARKDOWN",
      page: 9,
      pageSize: 1,
    });
    expect(page).toContain("1 match");
    expect(page).toContain("page 1/1");
    expect(page).toContain("I will inspect markdown tokens");
  });

  it("reports an empty result without throwing", () => {
    expect(
      formatHistoryPage(toHistoryLines(messages), { query: "missing" }),
    ).toContain("(no messages)");
  });
});

describe("REPL session paging (#192)", () => {
  it("slices a page and reports the total", () => {
    const result = formatSessionPage(["a", "b", "c", "d"], {
      page: 2,
      pageSize: 2,
    });
    expect(result.visible).toEqual(["c", "d"]);
    expect(result.text).toContain("page 2/2");
  });
});
