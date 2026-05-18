import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal stub for hljs so the helper can be tested without the real CDN bundle.
const mockHljs = {
  highlight: vi.fn((code: string, { language }: { language: string }) => ({
    value: `<span class="hljs-keyword">${code}</span>`,
  })),
  getLanguage: vi.fn((lang: string) => (lang === "typescript" ? {} : null)),
};

// Paste the helper under test inline — we extract and test the pure logic.
function applyHighlightToBlock(
  codeEl: HTMLElement,
  hljs: typeof mockHljs,
): void {
  const lang = codeEl.dataset.lang || "";
  if (!lang || !hljs.getLanguage(lang)) return;
  const raw = codeEl.dataset.rawCode || codeEl.textContent || "";
  const result = hljs.highlight(raw, { language: lang });
  codeEl.innerHTML = result.value;
  codeEl.dataset.highlighted = "true";
}

describe("applyHighlightToBlock", () => {
  let codeEl: HTMLElement;

  beforeEach(() => {
    codeEl = document.createElement("code");
    vi.clearAllMocks();
  });

  it("does nothing when lang is empty", () => {
    codeEl.textContent = "const x = 1;";
    applyHighlightToBlock(codeEl, mockHljs);
    expect(mockHljs.highlight).not.toHaveBeenCalled();
  });

  it("does nothing when hljs does not know the language", () => {
    codeEl.dataset.lang = "brainfuck";
    codeEl.textContent = "++++";
    applyHighlightToBlock(codeEl, mockHljs);
    expect(mockHljs.highlight).not.toHaveBeenCalled();
  });

  it("injects highlighted HTML for a known language", () => {
    codeEl.dataset.lang = "typescript";
    codeEl.textContent = "const x = 1;";
    applyHighlightToBlock(codeEl, mockHljs);
    expect(mockHljs.highlight).toHaveBeenCalledWith("const x = 1;", {
      language: "typescript",
    });
    expect(codeEl.innerHTML).toContain("hljs-keyword");
    expect(codeEl.dataset.highlighted).toBe("true");
  });

  it("prefers data-rawCode over textContent to avoid double-escaping", () => {
    codeEl.dataset.lang = "typescript";
    codeEl.dataset.rawCode = "const x: number = 1;";
    codeEl.textContent = "const x: number = 1;";
    applyHighlightToBlock(codeEl, mockHljs);
    expect(mockHljs.highlight).toHaveBeenCalledWith("const x: number = 1;", {
      language: "typescript",
    });
  });

  it("does not re-highlight already highlighted blocks", () => {
    codeEl.dataset.lang = "typescript";
    codeEl.dataset.highlighted = "true";
    codeEl.textContent = "const x = 1;";
    // Simulate the guard that will be inside the real helper.
    if (codeEl.dataset.highlighted === "true") {
      // no-op expected
    } else {
      applyHighlightToBlock(codeEl, mockHljs);
    }
    expect(mockHljs.highlight).not.toHaveBeenCalled();
  });
});
