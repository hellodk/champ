import { describe, it, expect } from "vitest";
import { isValidMessage } from "@/ui/messages";

describe("isValidMessage", () => {
  it("accepts well-formed messages", () => {
    expect(isValidMessage({ type: "foo" })).toBe(true);
    expect(isValidMessage({ type: "foo", payload: 123 })).toBe(true);
  });
  it("rejects malformed messages", () => {
    expect(isValidMessage(null)).toBe(false);
    expect(isValidMessage(undefined)).toBe(false);
    expect(isValidMessage({})).toBe(false);
    expect(isValidMessage({ type: 42 })).toBe(false);
    expect(isValidMessage("string")).toBe(false);
  });
});
