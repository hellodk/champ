import { describe, expect, it } from "vitest";
import { classifyFailure } from "@/config/runtime-status";

describe("classifyFailure", () => {
  it.each([
    ["Request timed out after 5000ms", "timeout"],
    ["HTTP 401 unauthorized", "auth"],
    ["HTTP 403 forbidden", "auth"],
    ["HTTP 404 model not found", "model_not_found"],
    ["HTTP 429 rate limit exceeded", "rate_limit"],
    ["HTTP 503 service unavailable", "server"],
    ["fetch failed: ECONNREFUSED", "network"],
    ["something unexpected", "unknown"],
  ])("classifies %s as %s", (input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });

  it("classifies Error objects without exposing their message", () => {
    expect(classifyFailure(new Error("AbortError: cancelled"))).toBe("timeout");
  });
});
