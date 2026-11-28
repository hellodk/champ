import { describe, expect, it, vi } from "vitest";
import {
  onboardEndpoint,
  validateEndpointUrl,
} from "@/config/endpoint-onboarding";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

describe("endpoint onboarding", () => {
  it("accepts HTTPS and loopback HTTP but rejects other plaintext hosts", () => {
    expect(validateEndpointUrl("https://api.example.com/v1").ok).toBe(true);
    expect(validateEndpointUrl("http://127.0.0.1:11434").ok).toBe(true);
    expect(validateEndpointUrl("http://localhost:8080/v1").ok).toBe(true);
    expect(validateEndpointUrl("http://lan-host.local:1234/v1").ok).toBe(true);
    expect(validateEndpointUrl("http://remote.example.com/v1").ok).toBe(false);
  });

  it("detects Ollama from /api/tags", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({
          models: [
            {
              name: "llama3.1:8b",
              model: "llama3.1:8b",
              context_length: 8192,
              capabilities: ["tools"],
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await onboardEndpoint(
      { url: "http://localhost:11434", apiKey: "" },
      { fetch: fetch as never, now: () => "2026-01-01T00:00:00.000Z" },
    );

    expect(result.protocol).toBe("ollama");
    expect(result.endpoint.provider).toBe("ollama");
    expect(result.models[0]).toMatchObject({
      id: "llama3.1:8b",
      contextWindow: 8192,
    });
    expect(result.models[0].capabilitySet?.tools).toBe("yes");
  });

  it("detects OpenAI-compatible servers from /v1/models", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return jsonResponse({
          data: [
            {
              id: "gemma-3-27b",
              context_length: 131072,
              capabilities: ["tools", "chat"],
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await onboardEndpoint(
      { url: "http://192.168.1.50:8000/v1", apiKey: "secret" },
      { fetch: fetch as never, now: () => "2026-01-01T00:00:00.000Z" },
    );

    expect(result.protocol).toBe("openai-compatible");
    expect(result.endpoint.provider).toBe("openai-compatible");
    expect(result.models[0].id).toBe("gemma-3-27b");
    expect(result.warnings.join(" ")).toContain("credential");
  });

  it("detects Anthropic and Gemini native model APIs", async () => {
    const anthropicFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.anthropic.com")) {
        return jsonResponse({ data: [{ id: "claude-sonnet-4-20250514" }] });
      }
      return jsonResponse({}, 404);
    });
    const anthropic = await onboardEndpoint(
      { url: "https://api.anthropic.com/v1", apiKey: "sk-ant-test" },
      {
        fetch: anthropicFetch as never,
        now: () => "2026-01-01T00:00:00.000Z",
      },
    );
    expect(anthropic.protocol).toBe("anthropic");
    expect(anthropic.endpoint.provider).toBe("claude");
    expect(
      anthropicFetch.mock.calls.some(
        (call) =>
          (call[1] as RequestInit | undefined)?.headers &&
          ((call[1] as RequestInit).headers as Record<string, string>)[
            "x-api-key"
          ] === "sk-ant-test",
      ),
    ).toBe(true);

    const geminiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1beta/models")) {
        return jsonResponse({
          models: [
            { name: "models/gemini-2.5-pro", inputTokenLimit: 1_000_000 },
          ],
        });
      }
      return jsonResponse({}, 404);
    });
    const gemini = await onboardEndpoint(
      {
        url: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "goog-test",
      },
      { fetch: geminiFetch as never, now: () => "2026-01-01T00:00:00.000Z" },
    );
    expect(gemini.protocol).toBe("gemini");
    expect(gemini.endpoint.provider).toBe("gemini");
    expect(gemini.models[0].contextWindow).toBe(1_000_000);
  });

  it("does not forward credentials on a cross-origin redirect", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/models") && !url.includes("evil.example")) {
          return redirectResponse("https://evil.example/v1/models");
        }
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization ?? headers.authorization).toBeUndefined();
        return jsonResponse({ data: [] });
      },
    );

    const result = await onboardEndpoint(
      { url: "http://localhost:1234/v1", apiKey: "secret" },
      { fetch: fetch as never, now: () => "2026-01-01T00:00:00.000Z" },
    );

    expect(result.warnings.join(" ")).toContain("cross-origin");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable error for malformed responses and supports manual entry", async () => {
    const fetch = vi.fn(async () => jsonResponse({ unexpected: true }));
    const result = await onboardEndpoint(
      {
        url: "https://api.example.com/v1",
        apiKey: "secret",
        manualModelIds: ["manual-model"],
      },
      { fetch: fetch as never, now: () => "2026-01-01T00:00:00.000Z" },
    );
    expect(result.error).toContain("No recognisable model list");
    expect(result.models.map((m) => m.id)).toEqual(["manual-model"]);
    expect(result.models[0].capabilitySet?.chat).toBe("unknown");
  });

  it("honours caller cancellation before any request", async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [] }));
    const controller = new AbortController();
    controller.abort();
    const result = await onboardEndpoint(
      { url: "https://api.example.com/v1", apiKey: "secret" },
      {
        fetch: fetch as never,
        now: () => "2026-01-01T00:00:00.000Z",
        signal: controller.signal,
      },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result.error).toBe("cancelled");
  });
});
