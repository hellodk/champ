import { describe, it, expect } from "vitest";
import {
  isEditUserMessage,
  type EditUserMessageRequest,
  type WebviewToExtensionMessage,
} from "../../src/ui/messages";

describe("isEditUserMessage type guard", () => {
  it("returns true for a valid editUserMessage", () => {
    const msg: EditUserMessageRequest = {
      type: "editUserMessage",
      originalText: "old",
      newText: "new",
    };
    expect(isEditUserMessage(msg)).toBe(true);
  });

  it("returns false for a userMessage", () => {
    const msg = {
      type: "userMessage",
      text: "hi",
    } as WebviewToExtensionMessage;
    expect(isEditUserMessage(msg)).toBe(false);
  });

  it("returns false for an unrelated message type", () => {
    const msg = { type: "cancelRequest" } as WebviewToExtensionMessage;
    expect(isEditUserMessage(msg)).toBe(false);
  });
});
