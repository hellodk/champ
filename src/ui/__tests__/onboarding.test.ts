// src/ui/__tests__/onboarding.test.ts
import { describe, it, expect } from "vitest";
import {
  createSessionTokenUsage,
  isSessionTokenUsageMessage,
  type ExtensionToWebviewMessage,
} from "../messages";
import { ChatViewProvider } from "../chat-view-provider";
import type { AgentController } from "../../agent/agent-controller";
import * as vscode from "vscode";

describe("SessionTokenUsageMessage", () => {
  it("createSessionTokenUsage builds the correct shape", () => {
    const msg = createSessionTokenUsage(1200, 340, 0.0042);
    expect(msg.type).toBe("sessionTokenUsage");
    expect(msg.sessionInputTokens).toBe(1200);
    expect(msg.sessionOutputTokens).toBe(340);
    expect(msg.estimatedCostUsd).toBeCloseTo(0.0042);
  });

  it("createSessionTokenUsage defaults estimatedCostUsd to 0 when omitted", () => {
    const msg = createSessionTokenUsage(100, 50);
    expect(msg.estimatedCostUsd).toBe(0);
  });

  it("isSessionTokenUsageMessage returns true for the correct type", () => {
    const msg = createSessionTokenUsage(10, 5, 0.001);
    expect(isSessionTokenUsageMessage(msg as never)).toBe(true);
  });

  it("isSessionTokenUsageMessage returns false for other types", () => {
    const other = { type: "streamEnd", usage: undefined };
    expect(isSessionTokenUsageMessage(other as never)).toBe(false);
  });
});

// Minimal fake webview that captures postMessage calls.
function makeTestProvider() {
  const posted: ExtensionToWebviewMessage[] = [];
  const fakeUri = {
    fsPath: "/fake",
    with: () => fakeUri,
    toString: () => "/fake",
  } as unknown as vscode.Uri;
  const fakeAgent = {
    getHistory: () => [],
    reset: () => {},
    setProjectRules: () => {},
    setMemoryBank: () => {},
    on: () => ({ dispose: () => {} }),
  } as unknown as AgentController;
  const provider = new ChatViewProvider(fakeUri, fakeAgent, "1.6.111");
  // Inject a fake view so postMessage works.
  (provider as unknown as { view: unknown }).view = {
    webview: {
      postMessage: (msg: ExtensionToWebviewMessage) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
      options: {},
      html: "",
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      cspSource: "",
      asWebviewUri: (u: vscode.Uri) => u,
    },
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    visible: true,
    badge: undefined,
    description: undefined,
    title: undefined,
    show: () => {},
  };
  return { provider, posted };
}

describe("ChatViewProvider.broadcastSessionTokenUsage", () => {
  it("posts a sessionTokenUsage message to the webview", () => {
    const { provider, posted } = makeTestProvider();
    provider.broadcastSessionTokenUsage(500, 120, 0.0015);
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("sessionTokenUsage");
    const msg = posted[0] as import("../messages").SessionTokenUsageMessage;
    expect(msg.sessionInputTokens).toBe(500);
    expect(msg.sessionOutputTokens).toBe(120);
    expect(msg.estimatedCostUsd).toBeCloseTo(0.0015);
  });

  it("defaults estimatedCostUsd to 0 when not passed", () => {
    const { provider, posted } = makeTestProvider();
    provider.broadcastSessionTokenUsage(100, 50);
    const msg = posted[0] as import("../messages").SessionTokenUsageMessage;
    expect(msg.estimatedCostUsd).toBe(0);
  });
});

import { estimateCost } from "../../config/token-cost";

describe("session token accumulator helpers", () => {
  // These pure-function helpers will be extracted from extension.ts logic
  // and exported for testability.

  /**
   * estimateCost(providerName, inputTokens, outputTokens) → USD
   * Uses a hardcoded rate table. Returns 0 for unknown/local providers.
   */
  it("estimateCost returns 0 for ollama", () => {
    expect(estimateCost("ollama", 1000, 500)).toBe(0);
  });

  it("estimateCost returns 0 for llamacpp", () => {
    expect(estimateCost("llamacpp", 1000, 500)).toBe(0);
  });

  it("estimateCost calculates claude-3-5-sonnet rate", () => {
    // claude: $3/M input, $15/M output
    const cost = estimateCost("claude", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 1);
  });

  it("estimateCost calculates openai gpt-4o rate", () => {
    // openai: $5/M input, $15/M output
    const cost = estimateCost("openai", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(20, 1);
  });

  it("estimateCost calculates gemini rate", () => {
    // gemini: $1.25/M input, $5/M output
    const cost = estimateCost("gemini", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6.25, 1);
  });
});

import {
  EMPTY_STATE_PROMPTS,
  EMPTY_STATE_TITLES,
} from "../../ui/empty-state-prompts";

describe("EMPTY_STATE_PROMPTS", () => {
  it("has entries for agent, ask, and plan modes", () => {
    expect(EMPTY_STATE_PROMPTS).toHaveProperty("agent");
    expect(EMPTY_STATE_PROMPTS).toHaveProperty("ask");
    expect(EMPTY_STATE_PROMPTS).toHaveProperty("plan");
  });

  it("each mode has exactly 4 prompts", () => {
    for (const mode of ["agent", "ask", "plan"] as const) {
      expect(EMPTY_STATE_PROMPTS[mode]).toHaveLength(4);
    }
  });

  it("each prompt has icon, label, and text fields", () => {
    for (const mode of ["agent", "ask", "plan"] as const) {
      for (const p of EMPTY_STATE_PROMPTS[mode]) {
        expect(typeof p.icon).toBe("string");
        expect(typeof p.label).toBe("string");
        expect(typeof p.text).toBe("string");
        expect(p.text.length).toBeGreaterThan(5);
      }
    }
  });

  it("EMPTY_STATE_TITLES has a title for each mode", () => {
    expect(typeof EMPTY_STATE_TITLES.agent).toBe("string");
    expect(typeof EMPTY_STATE_TITLES.ask).toBe("string");
    expect(typeof EMPTY_STATE_TITLES.plan).toBe("string");
  });
});
