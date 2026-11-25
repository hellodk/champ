/**
 * TDD: `champ browser` is protocol diagnostics, not a browser downloader.
 */
import { describe, expect, it, vi } from "vitest";
import { runBrowserCommand } from "@/cli/browser-commands";
import { readBrowserSettings } from "@/tools/browser-adapters";

function io(): {
  stdout: ReturnType<typeof vi.fn>;
  stderr: ReturnType<typeof vi.fn>;
} {
  return { stdout: vi.fn(), stderr: vi.fn() };
}

describe("browser command", () => {
  it("reports the configured W3C WebDriver endpoint on check", async () => {
    const output = io();
    const exit = await runBrowserCommand("check", output, {
      settings: readBrowserSettings({}),
      describeRuntime: async () => ({
        protocol: "webdriver",
        endpoint: "http://127.0.0.1:4444",
        ok: true,
        message: "W3C WebDriver endpoint ready",
      }),
    });

    expect(exit).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith(
      expect.stringContaining("W3C WebDriver endpoint ready"),
    );
  });

  it("reports a failing endpoint without suggesting a browser download", async () => {
    const output = io();
    const exit = await runBrowserCommand("check", output, {
      settings: readBrowserSettings({}),
      describeRuntime: async () => ({
        protocol: "webdriver",
        endpoint: "http://127.0.0.1:4444",
        ok: false,
        message: "W3C WebDriver endpoint unavailable: ECONNREFUSED",
      }),
    });

    expect(exit).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith(
      expect.stringContaining("W3C WebDriver endpoint unavailable"),
    );
    expect(output.stderr.mock.calls.join("\n")).not.toMatch(
      /Chromium|install/i,
    );
  });

  it("explains optional adapter installation without downloading a browser", async () => {
    const output = io();
    const exit = await runBrowserCommand("install", output, {
      settings: readBrowserSettings({}),
    });

    expect(exit).toBe(0);
    expect(output.stdout.mock.calls.join("\n")).toContain(
      "Champ does not bundle browsers",
    );
    expect(output.stdout.mock.calls.join("\n")).toContain(
      "CHAMP_WEBDRIVER_URL",
    );
  });
});
