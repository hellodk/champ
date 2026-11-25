import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  PALETTES,
  parseOsc11Response,
  resolveTheme,
  type ThemeName,
} from "@/tui/theme";

describe("TUI theme roles", () => {
  it("parses an OSC 11 background reply", () => {
    expect(parseOsc11Response("\u001b]11;rgb:0000/0000/0000\u001b\\")).toBe(
      "dark",
    );
    expect(parseOsc11Response("\u001b]11;rgb:ffff/ffff/ffff\u001b\\")).toBe(
      "light",
    );
    expect(parseOsc11Response("not a terminal reply")).toBeNull();
  });

  it("honors explicit overrides before the probe", () => {
    expect(
      resolveTheme({ CHAMP_THEME: "light", NO_COLOR: "1" }, undefined, "dark"),
    ).toBe("light");
    expect(resolveTheme({ FORCE_COLOR: "0" }, undefined, "dark")).toBe("dark");
  });

  it("falls back through env, probe, then dark", () => {
    expect(resolveTheme({ COLORFGBG: "0;15" }, undefined)).toBe("light");
    expect(resolveTheme({ COLORFGBG: "15;0" }, undefined)).toBe("dark");
    expect(resolveTheme({ TERM_PROGRAM: "Apple_Terminal" }, undefined)).toBe(
      "dark",
    );
    expect(resolveTheme({}, "light")).toBe("light");
    expect(resolveTheme({}, undefined)).toBe("dark");
  });

  it.each(["dark", "light"] as ThemeName[])(
    "keeps %s role colours legible on its surface",
    (theme) => {
      const palette = PALETTES[theme];
      expect(
        contrastRatio(palette.text, palette.surface),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(palette.muted, palette.surface),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(palette.accent, palette.surface),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(palette.error, palette.surface),
      ).toBeGreaterThanOrEqual(3);
    },
  );
});
