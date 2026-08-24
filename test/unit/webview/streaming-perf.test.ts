import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Regression guards for #110 (webview streaming perf):
 * - stream deltas must be rAF-batched, not rendered per token
 * - per-delta document-wide scans (injectRunButtons) must be gone
 * - highlight.js must not be eagerly loaded as a script tag
 */

const ROOT = path.resolve(__dirname, "../../..");
const MAIN_JS = readFileSync(
  path.join(ROOT, "webview-ui/static/main.js"),
  "utf8",
);
const PROVIDER = readFileSync(
  path.join(ROOT, "src/ui/chat-view-provider.ts"),
  "utf8",
);

describe("streaming render batching (#110)", () => {
  it("appendStreamDelta buffers and defers to the rAF scheduler", () => {
    const fn = MAIN_JS.slice(
      MAIN_JS.indexOf("function appendStreamDelta"),
      MAIN_JS.indexOf("function scheduleStreamRender"),
    );
    expect(fn).toContain("scheduleStreamRender(false)");
    // No direct DOM re-render inside the delta path
    expect(fn).not.toContain(".innerHTML = renderMarkdown(");
    expect(fn).not.toContain("applyHighlightToBlock");
  });

  it("mid-stream renders skip highlighting; final pass highlights once", () => {
    const fn = MAIN_JS.slice(
      MAIN_JS.indexOf("function flushStreamRender"),
      MAIN_JS.indexOf("let hljsReady"),
    );
    expect(fn).toContain("isFinal");
    // highlight only behind the final flag
    expect(fn).toMatch(
      /if \(isFinal\) \{\s*\n\s*highlightPendingBlocks\(body\);/,
    );
  });

  it("streamDelta message path performs no per-delta run-button scan", () => {
    const start = MAIN_JS.indexOf("case 'streamDelta':");
    const caseBody = MAIN_JS.slice(start, MAIN_JS.indexOf("case 'streamEnd'"));
    expect(caseBody).not.toContain("injectRunButtons()");
    const endCase = MAIN_JS.slice(
      MAIN_JS.indexOf("case 'streamEnd'"),
      MAIN_JS.indexOf("case 'streamEnd'") + 1200,
    );
    expect(endCase).toContain("scheduleStreamRender(true)");
  });
});

describe("lazy highlight.js (#110)", () => {
  it("provider no longer emits an eager hljs script tag", () => {
    expect(PROVIDER).not.toContain(
      `<script nonce="\${nonce}" src="\${hljsUri}">`,
    );
    expect(PROVIDER).toContain("__CHAMP_HLJS_SRC__");
  });

  it("main.js loads hljs lazily on first need", () => {
    expect(MAIN_JS).toContain("function ensureHljs");
    expect(MAIN_JS).toContain("__CHAMP_HLJS_SRC__");
    // Loader must create the script element dynamically, not at parse time
    expect(MAIN_JS).toContain("document.createElement('script')");
  });
});
