/**
 * TDD: the CDP adapter is optional and protocol-native. It must drive a page
 * through CDP commands using an injected WebSocket, with no browser binary or
 * Playwright package requirement.
 */
import { describe, expect, it } from "vitest";
import {
  createBrowserAdapter,
  readBrowserSettings,
} from "@/tools/browser-adapters";

interface CdpMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

class FakeWebSocket {
  onmessage?: (event: { data: string }) => void;
  onopen?: () => void;
  closed = false;
  sent: CdpMessage[] = [];

  constructor(public readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string): void {
    const message = JSON.parse(payload) as CdpMessage;
    this.sent.push(message);
    queueMicrotask(() => {
      const result =
        message.method === "Page.captureScreenshot"
          ? { data: "Y2RwLXNjcmVlbnNob3Q=" }
          : message.method === "Runtime.evaluate"
            ? { result: { type: "boolean", value: true } }
            : {};
      this.onmessage?.({
        data: JSON.stringify({ id: message.id, result }),
      });
    });
  }

  close(): void {
    this.closed = true;
  }
}

const settings = readBrowserSettings({
  CHAMP_BROWSER_PROTOCOL: "cdp",
  CHAMP_CDP_URL: "ws://cdp.test/devtools/page/1",
});

describe("CDP adapter", () => {
  function makeAdapter(): {
    adapter: ReturnType<typeof createBrowserAdapter>;
    socket: FakeWebSocket;
  } {
    const socket = new FakeWebSocket("ws://cdp.test/devtools/page/1");
    const adapter = createBrowserAdapter(settings, {
      webSocket: () => socket,
    });
    return { adapter, socket };
  }

  it("navigates with Page.navigate", async () => {
    const { adapter, socket } = makeAdapter();
    await adapter.navigate("https://example.test", { timeoutMs: 1000 });

    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        method: "Page.navigate",
        params: { url: "https://example.test" },
      }),
    );
  });

  it("clicks with a DOM evaluation scoped to the CSS selector", async () => {
    const { adapter, socket } = makeAdapter();
    await adapter.click("button#submit", { timeoutMs: 1000 });

    const evaluate = socket.sent.find((m) => m.method === "Runtime.evaluate");
    expect(String(evaluate?.params?.expression)).toContain("button#submit");
    expect(evaluate?.params?.returnByValue).toBe(true);
  });

  it("captures screenshots with Page.captureScreenshot", async () => {
    const { adapter } = makeAdapter();
    const screenshot = await adapter.screenshot({ timeoutMs: 1000 });
    expect(screenshot).toBe("Y2RwLXNjcmVlbnNob3Q=");
  });

  it("closes its WebSocket after use", async () => {
    const { adapter, socket } = makeAdapter();
    await adapter.navigate("https://example.test", { timeoutMs: 1000 });
    await adapter.close();
    expect(socket.closed).toBe(true);
  });
});
