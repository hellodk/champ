/**
 * TDD: a missing Chromium binary must be detected before launch and reported
 * with a command the operator can actually run.
 */
import { describe, expect, it, vi } from "vitest";
import {
  browserUnavailableMessage,
  detectBrowserRuntime,
} from "@/tools/browser-runtime";

describe("browser runtime detection", () => {
  it("reports an installed browser with its executable path", async () => {
    const status = await detectBrowserRuntime({
      executablePath: () => "/cache/chrome",
      exists: () => true,
    });

    expect(status.installed).toBe(true);
    expect(status.executablePath).toBe("/cache/chrome");
  });

  it("reports a missing browser with an actionable install command", async () => {
    const status = await detectBrowserRuntime({
      executablePath: () => "/cache/chrome",
      exists: () => false,
    });

    expect(status.installed).toBe(false);
    expect(status.installCommand).toContain("champ browser install");
    expect(browserUnavailableMessage(status)).toContain(status.installCommand);
  });

  it("does not crash when Playwright cannot resolve an executable", async () => {
    const executablePath = vi.fn(() => {
      throw new Error("playwright not installed");
    });

    const status = await detectBrowserRuntime({ executablePath });

    expect(status.installed).toBe(false);
    expect(status.reason).toContain("playwright not installed");
  });
});
