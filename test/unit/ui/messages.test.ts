/**
 * TDD: Tests for webview message protocol.
 * Validates message type constructors and discriminated-union shape.
 */
import { describe, it, expect } from "vitest";
import {
  createStreamDelta,
  createToolCallStart,
  createToolCallResult,
  createError,
  createConversationHistory,
  isUserMessage,
  isSetMode,
  isCancelRequest,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from "@/ui/messages";

describe("Webview Message Protocol", () => {
  describe("Extension -> Webview factories", () => {
    it("creates a streamDelta message", () => {
      const msg = createStreamDelta("Hello");
      expect(msg.type).toBe("streamDelta");
      expect(msg.text).toBe("Hello");
    });

    it("creates a toolCallStart message", () => {
      const msg = createToolCallStart("read_file", { path: "test.ts" });
      expect(msg.type).toBe("toolCallStart");
      expect(msg.toolName).toBe("read_file");
      expect(msg.args).toEqual({ path: "test.ts" });
    });

    it("creates a toolCallResult message", () => {
      const msg = createToolCallResult("read_file", "file contents", true);
      expect(msg.type).toBe("toolCallResult");
      expect(msg.toolName).toBe("read_file");
      expect(msg.success).toBe(true);
      expect(msg.result).toBe("file contents");
    });

    it("creates an error message", () => {
      const msg = createError("Rate limit exceeded");
      expect(msg.type).toBe("error");
      expect(msg.message).toBe("Rate limit exceeded");
    });

    it("creates a conversationHistory message", () => {
      const msg = createConversationHistory([]);
      expect(msg.type).toBe("conversationHistory");
      expect(msg.messages).toEqual([]);
    });
  });

  describe("Webview -> Extension type guards", () => {
    it("identifies a userMessage", () => {
      const msg: WebviewToExtensionMessage = {
        type: "userMessage",
        text: "Hi",
      };
      expect(isUserMessage(msg)).toBe(true);
    });

    it("identifies a setMode message", () => {
      const msg: WebviewToExtensionMessage = { type: "setMode", mode: "agent" };
      expect(isSetMode(msg)).toBe(true);
    });

    it("identifies a cancelRequest message", () => {
      const msg: WebviewToExtensionMessage = { type: "cancelRequest" };
      expect(isCancelRequest(msg)).toBe(true);
    });

    it("rejects unrelated messages", () => {
      const msg: WebviewToExtensionMessage = { type: "cancelRequest" };
      expect(isUserMessage(msg)).toBe(false);
      expect(isSetMode(msg)).toBe(false);
    });
  });

  describe("Type discrimination", () => {
    it("all Extension->Webview messages have a type tag", () => {
      const messages: ExtensionToWebviewMessage[] = [
        createStreamDelta("x"),
        createToolCallStart("t", {}),
        createToolCallResult("t", "r", true),
        createError("e"),
      ];
      for (const m of messages) {
        expect(typeof m.type).toBe("string");
      }
    });
  });

  describe("skill autocomplete protocol", () => {
    it("creates a skillAutocompleteResponse with a list of suggestions", async () => {
      const { createSkillAutocompleteResponse } = await import("@/ui/messages");
      const msg = createSkillAutocompleteResponse([
        { name: "explain", description: "Explain code" },
        { name: "test", description: "Generate tests" },
      ]);
      expect(msg.type).toBe("skillAutocompleteResponse");
      expect(msg.suggestions).toHaveLength(2);
      expect(msg.suggestions[0].name).toBe("explain");
    });

    it("identifies a skillAutocompleteRequest from the webview", async () => {
      const { isSkillAutocompleteRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = {
        type: "skillAutocompleteRequest",
        prefix: "ex",
      };
      expect(isSkillAutocompleteRequest(msg)).toBe(true);
    });

    it("rejects unrelated messages from the skillAutocomplete guard", async () => {
      const { isSkillAutocompleteRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "cancelRequest" };
      expect(isSkillAutocompleteRequest(msg)).toBe(false);
    });
  });

  describe("provider status protocol (Chat UI v2)", () => {
    it("creates a providerStatus message with state, names, and available list", async () => {
      const { createProviderStatus } = await import("@/ui/messages");
      const msg = createProviderStatus({
        state: "ready",
        providerName: "ollama",
        modelName: "qwen2.5-coder:14b",
        available: [
          {
            providerName: "ollama",
            modelName: "qwen2.5-coder:14b",
            label: "ollama: qwen2.5-coder:14b",
          },
          {
            providerName: "vllm",
            modelName: "meta-llama/Llama-3.1-8B",
            label: "vllm: meta-llama/Llama-3.1-8B",
          },
        ],
      });
      expect(msg.type).toBe("providerStatus");
      expect(msg.state).toBe("ready");
      expect(msg.providerName).toBe("ollama");
      expect(msg.modelName).toBe("qwen2.5-coder:14b");
      expect(msg.available).toHaveLength(2);
      expect(msg.available[0].label).toContain("ollama");
    });

    it("createProviderStatus supports loading state without provider info", async () => {
      const { createProviderStatus } = await import("@/ui/messages");
      const msg = createProviderStatus({ state: "loading", available: [] });
      expect(msg.type).toBe("providerStatus");
      expect(msg.state).toBe("loading");
      expect(msg.providerName).toBeUndefined();
      expect(msg.available).toEqual([]);
    });

    it("createProviderStatus supports error state with errorMessage", async () => {
      const { createProviderStatus } = await import("@/ui/messages");
      const msg = createProviderStatus({
        state: "error",
        errorMessage: "Connection refused",
        available: [],
      });
      expect(msg.state).toBe("error");
      expect(msg.errorMessage).toBe("Connection refused");
    });
  });

  describe("settings, help, and setModel protocols (Chat UI v2)", () => {
    it("identifies an openSettingsRequest", async () => {
      const { isOpenSettingsRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "openSettingsRequest" };
      expect(isOpenSettingsRequest(msg)).toBe(true);
    });

    it("rejects unrelated messages from the openSettings guard", async () => {
      const { isOpenSettingsRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "cancelRequest" };
      expect(isOpenSettingsRequest(msg)).toBe(false);
    });

    it("identifies a showHelpRequest", async () => {
      const { isShowHelpRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "showHelpRequest" };
      expect(isShowHelpRequest(msg)).toBe(true);
    });

    it("rejects unrelated messages from the showHelp guard", async () => {
      const { isShowHelpRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "newChat" };
      expect(isShowHelpRequest(msg)).toBe(false);
    });

    it("identifies a setModelRequest with providerName", async () => {
      const { isSetModelRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = {
        type: "setModelRequest",
        providerName: "vllm",
      };
      expect(isSetModelRequest(msg)).toBe(true);
    });

    it("rejects unrelated messages from the setModel guard", async () => {
      const { isSetModelRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "newChat" };
      expect(isSetModelRequest(msg)).toBe(false);
    });
  });

  describe("first-run onboarding protocol (Phase B)", () => {
    it("creates a firstRunWelcome message with a templates list", async () => {
      const { createFirstRunWelcome } = await import("@/ui/messages");
      const templates = [
        {
          id: "ollama-basic",
          label: "Local: Ollama",
          description: "Privacy-first",
        },
        {
          id: "claude",
          label: "Cloud: Claude",
          description: "Requires API key",
        },
      ];
      const msg = createFirstRunWelcome(templates);
      expect(msg.type).toBe("firstRunWelcome");
      expect(msg.templates).toHaveLength(2);
      expect(msg.templates[0].id).toBe("ollama-basic");
    });

    it("identifies a firstRunSelectRequest from the webview", async () => {
      const { isFirstRunSelectRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = {
        type: "firstRunSelectRequest",
        templateId: "ollama-basic",
      };
      expect(isFirstRunSelectRequest(msg)).toBe(true);
    });

    it("rejects unrelated messages from the firstRunSelect guard", async () => {
      const { isFirstRunSelectRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "cancelRequest" };
      expect(isFirstRunSelectRequest(msg)).toBe(false);
    });

    it("identifies a firstRunDismissRequest from the webview", async () => {
      const { isFirstRunDismissRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "firstRunDismissRequest" };
      expect(isFirstRunDismissRequest(msg)).toBe(true);
    });
  });

  describe("attach file protocol (Phase C)", () => {
    it("identifies an attachFileRequest from the webview", async () => {
      const { isAttachFileRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = {
        type: "attachFileRequest",
        filename: "readme.md",
        mimeType: "text/markdown",
        contentBase64: "SGVsbG8=",
      };
      expect(isAttachFileRequest(msg)).toBe(true);
    });

    it("rejects unrelated messages from the attachFile guard", async () => {
      const { isAttachFileRequest } = await import("@/ui/messages");
      const msg: WebviewToExtensionMessage = { type: "cancelRequest" };
      expect(isAttachFileRequest(msg)).toBe(false);
    });
  });
});
