import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const MAIN_JS = readFileSync(
  path.join(ROOT, "webview-ui/static/main.js"),
  "utf8",
);
const MAIN_CSS = readFileSync(
  path.join(ROOT, "webview-ui/static/main.css"),
  "utf8",
);

describe("webview session search (#192)", () => {
  it("offers a filter input in the all-sessions menu", () => {
    expect(MAIN_JS).toMatch(/class: 'session-search-input'/);
    expect(MAIN_JS).toMatch(/placeholder: 'Filter sessions/);
    expect(MAIN_JS).toMatch(
      /appendOverflowItems\(results, filterSessions\(sessions, sessionFilter\)\)/,
    );
  });

  it("filters on id, label and message preview", () => {
    const section = MAIN_JS.slice(
      MAIN_JS.indexOf("function filterSessions"),
      MAIN_JS.indexOf("function renderSessionList"),
    );
    expect(section).toContain("s.id, s.label, s.preview || ''");
  });

  it("styles the search input with theme variables", () => {
    const section = MAIN_CSS.slice(
      MAIN_CSS.indexOf(".session-search-input"),
      MAIN_CSS.indexOf(".overflow-item {"),
    );
    expect(section).toContain("var(--vscode-input-background)");
  });
});
