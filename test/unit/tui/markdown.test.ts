import { describe, expect, it } from "vitest";
import { markdownToLines } from "@/tui/markdown";

describe("TUI markdown rendering (#193)", () => {
  it("renders headings, inline code and links as styled segments", () => {
    const lines = markdownToLines(
      "# Title\n\nUse `code` and [docs](https://example.com) here.",
      80,
    );
    expect(lines[0]).toMatchObject({ kind: "heading", text: "Title" });
    const body = lines[1];
    expect(body.kind).toBe("body");
    expect(body.segments.some((s) => s.code && s.text === "code")).toBe(true);
    expect(body.segments.some((s) => s.link && s.text === "docs")).toBe(true);
  });

  it("renders ordered and unordered lists with bullets", () => {
    const lines = markdownToLines("- one\n- two\n\n1. first\n2. second", 80);
    expect(lines.filter((l) => l.kind === "list").map((l) => l.text)).toEqual([
      "• one",
      "• two",
      "1. first",
      "2. second",
    ]);
  });

  it("highlights fenced code blocks with highlight.js", () => {
    const lines = markdownToLines("```ts\nconst value = 1;\n```", 80);
    expect(
      lines.some((l) => l.kind === "code" && l.text.includes("const")),
    ).toBe(true);
    expect(
      lines.some((l) => l.segments.some((s) => s.highlight === "keyword")),
    ).toBe(true);
  });

  it("keeps an unterminated fence renderable while streaming", () => {
    const lines = markdownToLines("```ts\nconst value = 1;", 80);
    expect(
      lines.some((l) => l.kind === "code" && l.text.includes("const")),
    ).toBe(true);
  });

  it("leaves plain text untouched", () => {
    expect(markdownToLines("hello world", 80).map((l) => l.text)).toEqual([
      "hello world",
    ]);
  });
});
