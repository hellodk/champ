/**
 * TDD: protocol selection is explicit and optional. The default path must not
 * touch the optional Playwright package.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserAdapter,
  readBrowserSettings,
} from "@/tools/browser-adapters";

function okResponse(value: unknown): Response {
  return new Response(JSON.stringify({ value }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("browser protocol configuration", () => {
  it("defaults to W3C WebDriver on the standard local endpoint", () => {
    const settings = readBrowserSettings({});
    expect(settings.protocol).toBe("webdriver");
    expect(settings.webdriverUrl).toBe("http://127.0.0.1:4444");
    expect(settings.capabilities).toEqual({});
  });

  it("rejects unknown protocols instead of silently falling back", () => {
    expect(() =>
      readBrowserSettings({ CHAMP_BROWSER_PROTOCOL: "selenium" }),
    ).toThrow(/webdriver|remote|cdp|playwright/i);
  });

  it("requires an explicit URL for remote and CDP adapters", () => {
    expect(() =>
      readBrowserSettings({ CHAMP_BROWSER_PROTOCOL: "remote" }),
    ).toThrow(/CHAMP_REMOTE_BROWSER_URL/);
    expect(() =>
      readBrowserSettings({ CHAMP_BROWSER_PROTOCOL: "cdp" }),
    ).toThrow(/CHAMP_CDP_URL/);
  });

  it("routes the remote adapter to its configured WebDriver endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      urls.push(String(input));
      return okResponse(
        urls.length === 1 ? { sessionId: "remote-1", capabilities: {} } : null,
      );
    };
    const settings = readBrowserSettings({
      CHAMP_BROWSER_PROTOCOL: "remote",
      CHAMP_REMOTE_BROWSER_URL: "http://grid.test/wd/hub",
    });
    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });

    await adapter.navigate("https://example.test", { timeoutMs: 1000 });

    expect(adapter.protocol).toBe("remote");
    expect(urls[1]).toBe("http://grid.test/wd/hub/session/remote-1/url");
  });

  it("does not import Playwright for the default adapter", () => {
    const importPlaywright = vi.fn();
    const adapter = createBrowserAdapter(readBrowserSettings({}), {
      importPlaywright,
    });

    expect(adapter.protocol).toBe("webdriver");
    expect(importPlaywright).not.toHaveBeenCalled();
  });

  it("lazy-loads Playwright only when that optional adapter is selected", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(null),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("png")),
      click: vi.fn().mockResolvedValue(null),
      fill: vi.fn().mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(null),
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(null),
    };
    const importPlaywright = vi.fn().mockResolvedValue({
      chromium: { launch: vi.fn().mockResolvedValue(browser) },
    });

    const adapter = createBrowserAdapter(
      readBrowserSettings({
        CHAMP_BROWSER_PROTOCOL: "playwright",
        CHAMP_PLAYWRIGHT_BROWSER: "chromium",
      }),
      { importPlaywright },
    );

    await adapter.navigate("https://example.test", { timeoutMs: 1000 });

    expect(adapter.protocol).toBe("playwright");
    expect(importPlaywright).toHaveBeenCalledOnce();
  });
});
