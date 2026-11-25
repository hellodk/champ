/**
 * TDD: browser diagnostics describe the configured adapter. The default
 * WebDriver path checks a driver endpoint; it never downloads a browser.
 */
import { describe, expect, it } from "vitest";
import {
  describeBrowserRuntime,
  readBrowserSettings,
} from "@/tools/browser-adapters";

function statusResponse(): Response {
  return new Response(JSON.stringify({ value: { ready: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("browser runtime diagnostics", () => {
  it("reports a reachable W3C WebDriver endpoint by default", async () => {
    const status = await describeBrowserRuntime(readBrowserSettings({}), {
      fetch: async () => statusResponse(),
    });

    expect(status.protocol).toBe("webdriver");
    expect(status.endpoint).toBe("http://127.0.0.1:4444");
    expect(status.ok).toBe(true);
    expect(status.message).toContain("W3C WebDriver");
  });

  it("explains how to configure an unreachable driver without mentioning Chromium", async () => {
    const status = await describeBrowserRuntime(readBrowserSettings({}), {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect(status.ok).toBe(false);
    expect(status.message).toContain("CHAMP_WEBDRIVER_URL");
    expect(status.message).not.toMatch(/Chromium|browser install/i);
  });

  it("describes Playwright as an optional adapter without checking for a browser binary", async () => {
    const status = await describeBrowserRuntime(
      readBrowserSettings({ CHAMP_BROWSER_PROTOCOL: "playwright" }),
    );

    expect(status.protocol).toBe("playwright");
    expect(status.message).toContain("optional Playwright adapter");
    expect(status.message).not.toMatch(/Chromium|browser install/i);
  });

  it("describes the configured remote endpoint", async () => {
    const status = await describeBrowserRuntime(
      readBrowserSettings({
        CHAMP_BROWSER_PROTOCOL: "remote",
        CHAMP_REMOTE_BROWSER_URL: "http://grid.test/wd/hub",
      }),
      { fetch: async () => statusResponse() },
    );

    expect(status.protocol).toBe("remote");
    expect(status.endpoint).toBe("http://grid.test/wd/hub");
    expect(status.ok).toBe(true);
  });
});
