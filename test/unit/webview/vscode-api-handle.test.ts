import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Regression tests for the blank-webview crash.
 *
 * VS Code allows acquireVsCodeApi() to be called EXACTLY ONCE per webview.
 * main.js calls it at load; components.js loads immediately after. If any
 * module in components.js calls it a second time at module-evaluation time,
 * the whole bundle throws and the webview renders blank.
 *
 * The contract is: main.js publishes its handle on window.vscode, and every
 * component reads that handle instead of acquiring its own.
 */

const ROOT = path.resolve(__dirname, "../../..");
const MAIN_JS = path.join(ROOT, "webview-ui/static/main.js");
const COMPONENTS_JS = path.join(ROOT, "webview-ui/dist/components.js");

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (s: unknown) => void;
}

/**
 * Install a stub that mirrors real VS Code behaviour: the second call
 * throws. Without this, a double-acquire is invisible to tests.
 */
function installSingleUseApiStub(): {
  acquisitions: () => number;
  api: VsCodeApi;
} {
  let acquisitions = 0;
  const api: VsCodeApi = {
    postMessage: () => {},
    getState: () => ({}),
    setState: () => {},
  };
  (
    globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }
  ).acquireVsCodeApi = () => {
    acquisitions += 1;
    if (acquisitions > 1) {
      throw new Error(
        "An instance of the VS Code API has already been acquired",
      );
    }
    return api;
  };
  return { acquisitions: () => acquisitions, api };
}

/**
 * Evaluate a bundle in the jsdom global scope. main.js builds the entire
 * chat UI and may throw later on missing DOM — that is not what these
 * tests are about, so DOM-shaped failures after the API handshake are
 * swallowed and reported instead of failing the test.
 */
function evaluateInGlobalScope(src: string): Error | null {
  try {
    new Function(src)();
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe("webview VS Code API handle", () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).vscode;
    delete (globalThis as unknown as Record<string, unknown>).acquireVsCodeApi;
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).vscode;
    delete (globalThis as unknown as Record<string, unknown>).acquireVsCodeApi;
  });

  it("main.js publishes its acquired handle on window.vscode", () => {
    const stub = installSingleUseApiStub();
    evaluateInGlobalScope(readFileSync(MAIN_JS, "utf8"));

    expect(stub.acquisitions()).toBe(1);
    expect((window as unknown as { vscode?: VsCodeApi }).vscode).toBe(stub.api);
  });

  it("components.js evaluates without acquiring the API a second time", () => {
    expect(
      existsSync(COMPONENTS_JS),
      "components.js missing — run `pnpm run build:webview`",
    ).toBe(true);

    const stub = installSingleUseApiStub();
    evaluateInGlobalScope(readFileSync(MAIN_JS, "utf8"));

    const componentsError = evaluateInGlobalScope(
      readFileSync(COMPONENTS_JS, "utf8"),
    );

    expect(componentsError).toBeNull();
    expect(stub.acquisitions()).toBe(1);
  });

  it("every panel component reads window.vscode before acquiring", () => {
    // MemoryPanel was the sole panel acquiring the handle at module scope;
    // the others all use a lazy getVsCode() called on interaction.
    const panels = [
      "DiffOverlayPanel",
      "AgentGraphPanel",
      "McpMarketplacePanel",
      "TeamBuilderPanel",
      "RulesEditorPanel",
      "MemoryPanel",
    ];

    for (const panel of panels) {
      const src = readFileSync(
        path.join(ROOT, "webview-ui/src/components", `${panel}.tsx`),
        "utf8",
      );
      expect(
        /function getVsCode\(/.test(src),
        `${panel}.tsx must use a lazy getVsCode() function, not a module-level const`,
      ).toBe(true);
    }
  });
});
