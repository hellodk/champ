import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The chat UI's mode picker (agent / ask / manual / plan / composer) must
 * use standard VS Code codicon glyphs, not emoji. Emoji render differently
 * across platforms and never match the editor theme's icon font.
 */
const ROOT = path.resolve(__dirname, "../../..");
const MAIN_JS = readFileSync(
  path.join(ROOT, "webview-ui/static/main.js"),
  "utf8",
);

const MODE_SECTION = MAIN_JS.slice(
  MAIN_JS.indexOf("const modeIcons"),
  MAIN_JS.indexOf("const modeDescs"),
);

describe("mode picker icons use standard codicons", () => {
  it("maps every mode to a codicon name (no emoji)", () => {
    const names = ["agent", "ask", "manual", "plan", "composer"];
    for (const mode of names) {
      expect(MODE_SECTION, `mode '${mode}' must have a codicon entry`).toMatch(
        new RegExp(`${mode}:\\s*'[a-z-]+'`),
      );
    }
  });

  it("does not use emoji glyphs in the mode icon map", () => {
    expect(MODE_SECTION).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("renders mode icons through the codicon() helper", () => {
    expect(MAIN_JS).toMatch(/codicon\(modeIcons\[m\] \|\| 'circuit-board'\)/);
  });
});
