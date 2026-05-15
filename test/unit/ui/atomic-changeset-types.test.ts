import { describe, it, expect } from "vitest";
import type {
  AcceptAllEditsRequest,
  RevertAllEditsRequest,
  WebviewToExtensionMessage,
} from "../../../src/ui/messages";
import {
  isAcceptAllEditsRequest,
  isRevertAllEditsRequest,
} from "../../../src/ui/messages";

describe("AcceptAllEditsRequest type guard", () => {
  it("accepts a valid acceptAllEdits message", () => {
    const msg: AcceptAllEditsRequest = { type: "acceptAllEdits" };
    expect(isAcceptAllEditsRequest(msg)).toBe(true);
  });
  it("rejects other types", () => {
    expect(
      isAcceptAllEditsRequest({
        type: "revertEdit",
        path: "",
        restoreContent: "",
      } as unknown as WebviewToExtensionMessage),
    ).toBe(false);
  });
});

describe("RevertAllEditsRequest type guard", () => {
  it("accepts a valid revertAllEdits message", () => {
    const msg: RevertAllEditsRequest = {
      type: "revertAllEdits",
      edits: [{ path: "a.ts", restoreContent: "old" }],
    };
    expect(isRevertAllEditsRequest(msg)).toBe(true);
  });
  it("rejects other types", () => {
    expect(
      isRevertAllEditsRequest({
        type: "acceptAllEdits",
      } as unknown as WebviewToExtensionMessage),
    ).toBe(false);
  });
});

describe("WebviewToExtensionMessage union", () => {
  it("accepts AcceptAllEditsRequest", () => {
    const msg: WebviewToExtensionMessage = { type: "acceptAllEdits" };
    expect(msg.type).toBe("acceptAllEdits");
  });
  it("accepts RevertAllEditsRequest", () => {
    const msg: WebviewToExtensionMessage = {
      type: "revertAllEdits",
      edits: [{ path: "a.ts", restoreContent: "" }],
    };
    expect(msg.type).toBe("revertAllEdits");
  });
});
