// src/ui/__tests__/onboarding.test.ts
import { describe, it, expect } from "vitest";
import {
  createSessionTokenUsage,
  isSessionTokenUsageMessage,
} from "../messages";

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
