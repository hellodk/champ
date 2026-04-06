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
});
