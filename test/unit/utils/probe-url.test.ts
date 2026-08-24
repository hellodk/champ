/**
 * TDD: provider connectivity probe URL builder (#115 follow-up).
 *
 * Contract: no double /v1 for correctly-configured baseUrls, and /v1 is
 * supplied for OpenAI-spec providers when the user omitted it.
 */
import { describe, it, expect } from "vitest";
import { buildProbeUrl } from "../../../src/utils/probe-url";

describe("buildProbeUrl", () => {
  it("does not double the /v1 suffix", () => {
    expect(buildProbeUrl("http://h:8000/v1", "openai-compatible")).toBe(
      "http://h:8000/v1/models",
    );
    expect(buildProbeUrl("http://h:8000/v1/", "llamacpp")).toBe(
      "http://h:8000/v1/models",
    );
  });

  it("supplies /v1 when the baseUrl omits it (OpenAI-spec providers)", () => {
    expect(buildProbeUrl("http://h:8000", "openai-compatible")).toBe(
      "http://h:8000/v1/models",
    );
    expect(buildProbeUrl("http://h:8000/", "vllm")).toBe(
      "http://h:8000/v1/models",
    );
  });

  it("uses the ollama native endpoint regardless of /v1", () => {
    expect(buildProbeUrl("http://localhost:11434", "ollama")).toBe(
      "http://localhost:11434/api/tags",
    );
    expect(buildProbeUrl("http://localhost:11434/v1", "ollama")).toBe(
      "http://localhost:11434/api/tags",
    );
  });

  it("falls back to /v1/models for unknown providers", () => {
    expect(buildProbeUrl("http://h:9000", "something-else")).toBe(
      "http://h:9000/v1/models",
    );
  });
});
