import { describe, it, expect } from "vitest";
import type {
  AutoContextNoticeMessage,
  ExtensionToWebviewMessage,
} from "../messages";

describe("AutoContextNoticeMessage type", () => {
  it("is a valid ExtensionToWebviewMessage", () => {
    const msg: ExtensionToWebviewMessage = {
      type: "autoContextNotice",
      files: ["src/app.ts"],
    } satisfies AutoContextNoticeMessage;
    expect(msg.type).toBe("autoContextNotice");
  });

  it("files array is required", () => {
    const msg: AutoContextNoticeMessage = {
      type: "autoContextNotice",
      files: ["src/foo.ts", "src/bar.ts"],
    };
    expect(msg.files).toHaveLength(2);
  });
});
