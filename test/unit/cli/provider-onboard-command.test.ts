import { describe, expect, it, vi } from "vitest";
import { runProviderCommand, type CommandDeps } from "@/cli/provider-commands";
import type { CredentialStore } from "@/config/credential-store";
import type { EndpointRegistry } from "@/config/endpoint-registry";

function depsFor(
  registry: EndpointRegistry,
  credentials: CredentialStore,
  onboardingFetch: typeof globalThis.fetch,
) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      registry,
      credentials,
      onboardingFetch,
      cwd: "/tmp",
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    } as CommandDeps,
  };
}

describe("provider onboard command", () => {
  it("stores the API key only in the credential store and reports the protocol", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    const set = vi.fn(async () => undefined);
    const credentials = {
      get: async () => undefined,
      set,
      delete: async () => undefined,
    };
    const add = vi.fn(async (endpoint: unknown) => endpoint);
    const registry = { add } as unknown as EndpointRegistry;
    const { deps, out, err } = depsFor(
      registry,
      credentials,
      fetchMock as unknown as typeof globalThis.fetch,
    );

    const code = await runProviderCommand(
      {
        name: "provider-onboard",
        url: "https://api.example.com/v1",
        apiKey: "sk-secret",
        endpointName: "onboarded",
      },
      deps,
    );

    expect(code).toBe(0);
    const added = add.mock.calls[0]?.[0] as {
      credential: { kind: string; id: string };
    };
    expect(set).toHaveBeenCalledWith(added.credential, "sk-secret");
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        credential: { kind: "keyring", id: expect.any(String) },
      }),
    );
    expect(out.join("")).toContain("openai-compatible");
    expect(out.join("")).not.toContain("sk-secret");
    expect(err.join("")).not.toContain("sk-secret");
    expect(fetchMock).toHaveBeenCalled();
  });
});
