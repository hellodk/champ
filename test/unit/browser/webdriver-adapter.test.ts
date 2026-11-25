/**
 * TDD: W3C WebDriver is Champ's default browser protocol. The adapter must
 * speak the standard HTTP protocol without importing Playwright or requiring
 * a vendor-specific browser binary.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserAdapter,
  readBrowserSettings,
} from "@/tools/browser-adapters";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const W3C_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify({ value }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(values: unknown[]): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let index = 0;
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const value = values[index++];
    return jsonResponse(value);
  }) as FetchLike & ReturnType<typeof vi.fn>;
  return { fetchImpl, calls };
}

const settings = readBrowserSettings({
  CHAMP_WEBDRIVER_URL: "http://driver.test/wd/hub",
  CHAMP_BROWSER_CAPABILITIES_JSON: '{"browserName":"firefox"}',
});

describe("W3C WebDriver adapter", () => {
  it("creates a session with configured capabilities before navigating", async () => {
    const { fetchImpl, calls } = recordingFetch([
      { sessionId: "session-1", capabilities: {} },
      null,
    ]);

    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });
    await adapter.navigate("https://example.test", { timeoutMs: 1000 });

    expect(calls[0]).toMatchObject({
      url: "http://driver.test/wd/hub/session",
      method: "POST",
    });
    expect(calls[0].body).toEqual({
      capabilities: { alwaysMatch: { browserName: "firefox" } },
    });
    expect(calls[1]).toMatchObject({
      url: "http://driver.test/wd/hub/session/session-1/url",
      method: "POST",
      body: { url: "https://example.test" },
    });
  });

  it("clicks a W3C element reference and deletes the session on close", async () => {
    const { fetchImpl, calls } = recordingFetch([
      { sessionId: "session-2", capabilities: {} },
      { [W3C_ELEMENT_KEY]: "element-7" },
      null,
      null,
    ]);

    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });
    await adapter.click("#submit", { timeoutMs: 1000 });
    await adapter.close();

    expect(calls[1]).toMatchObject({
      url: "http://driver.test/wd/hub/session/session-2/element",
      body: { using: "css selector", value: "#submit" },
    });
    expect(calls[2]).toMatchObject({
      url: "http://driver.test/wd/hub/session/session-2/element/element-7/click",
      method: "POST",
    });
    expect(calls[3]).toMatchObject({
      url: "http://driver.test/wd/hub/session/session-2",
      method: "DELETE",
    });
  });

  it("sends W3C text to a legacy element reference", async () => {
    const { fetchImpl, calls } = recordingFetch([
      { sessionId: "session-3", capabilities: {} },
      { ELEMENT: "element-8" },
      null,
    ]);

    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });
    await adapter.type("input[name=q]", "hello", { timeoutMs: 1000 });

    expect(calls[2]).toMatchObject({
      url: "http://driver.test/wd/hub/session/session-3/element/element-8/value",
      method: "POST",
      body: { text: "hello" },
    });
  });

  it("returns the base64 screenshot body from the standard endpoint", async () => {
    const { fetchImpl, calls } = recordingFetch([
      { sessionId: "session-4", capabilities: {} },
      "c2NyZWVuc2hvdA==",
    ]);

    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });
    const screenshot = await adapter.screenshot({ timeoutMs: 1000 });

    expect(screenshot).toBe("c2NyZWVuc2hvdA==");
    expect(calls[1]).toMatchObject({
      url: "http://driver.test/wd/hub/session/session-4/screenshot",
      method: "GET",
    });
  });

  it("surfaces W3C error objects with their message", async () => {
    const { fetchImpl } = recordingFetch([
      { error: "session not created", message: "no matching driver" },
    ]);
    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });

    await expect(
      adapter.navigate("https://example.test", { timeoutMs: 1000 }),
    ).rejects.toThrow(/session not created.*no matching driver/);
  });

  it("rejects an element response without a W3C element id", async () => {
    const { fetchImpl } = recordingFetch([
      { sessionId: "session-5", capabilities: {} },
      {},
    ]);
    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });

    await expect(
      adapter.click("#missing", { timeoutMs: 1000 }),
    ).rejects.toThrow(/element id/i);
  });

  it("honours an already aborted operation signal before making a request", async () => {
    const { fetchImpl } = recordingFetch([]);
    const controller = new AbortController();
    controller.abort();

    const adapter = createBrowserAdapter(settings, { fetch: fetchImpl });
    await expect(
      adapter.navigate("https://example.test", {
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates the WebDriver endpoint scheme", () => {
    expect(() =>
      readBrowserSettings({ CHAMP_WEBDRIVER_URL: "file:///tmp/driver" }),
    ).toThrow(/http/i);
  });
});
