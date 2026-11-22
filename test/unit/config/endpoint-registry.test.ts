import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ChainCredentialStore,
  type KeyringBackend,
} from "@/config/credential-store";
import { EndpointRegistry } from "@/config/endpoint-registry";
import { discoverModels, testEndpoint } from "@/config/model-discovery";
import { EndpointRepository } from "@/config/provider-repository";

function makeInMemoryKeyring(): KeyringBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    isAvailable: () => true,
    unavailableReason: () => undefined,
    get: async (id) => map.get(id),
    set: async (id, secret) => {
      map.set(id, secret);
    },
    delete: async (id) => {
      map.delete(id);
    },
  };
}

describe("EndpointRegistry + ModelDiscovery", () => {
  const dirs: string[] = [];

  function createHarness(fetchImpl?: typeof fetch) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-reg-test-"));
    dirs.push(home);
    const repository = new EndpointRepository({ homeDir: home });
    const keyring = makeInMemoryKeyring();
    const credentials = new ChainCredentialStore({ keyring, env: {} });
    const now = () => "2026-11-22T05:00:00.000Z";
    const mockFetch: typeof fetch =
      fetchImpl ??
      (vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch);

    const registry = new EndpointRegistry({
      repository,
      credentials,
      discovery: { discoverModels, testEndpoint },
      now,
      fetch: mockFetch,
    });
    return { home, repository, keyring, credentials, registry, mockFetch };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assigns an id and makes the first endpoint default", async () => {
    const { registry } = createHarness();
    const ep = await registry.add({
      name: "Local Ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });

    expect(ep.id).toMatch(/^ep_/);
    expect(ep.isDefault).toBe(true);
    expect(ep.enabled).toBe(true);

    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(ep.id);
  });

  it("rejects duplicate names case-insensitively without writing", async () => {
    const { registry, repository } = createHarness();
    await registry.add({
      name: "Primary",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    const mtimeBefore = fs.statSync(repository.path()).mtimeMs;

    await expect(
      registry.add({
        name: "primary",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
      }),
    ).rejects.toThrow(/duplicate|already exists/i);

    expect(await registry.list()).toHaveLength(1);
    expect(fs.statSync(repository.path()).mtimeMs).toBe(mtimeBefore);
  });

  it("setDefault clears exactly one previous default", async () => {
    const { registry } = createHarness();
    const first = await registry.add({
      name: "First",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    const second = await registry.add({
      name: "Second",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });

    await registry.setDefault(second.id);
    const list = await registry.list();
    expect(list.find((e) => e.id === first.id)?.isDefault).toBe(false);
    expect(list.find((e) => e.id === second.id)?.isDefault).toBe(true);
  });

  it("disabling the default clears its isDefault flag", async () => {
    const { registry } = createHarness();
    const ep = await registry.add({
      name: "Default One",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });

    await registry.setEnabled(ep.id, false);
    const updated = (await registry.list())[0];
    expect(updated.enabled).toBe(false);
    expect(updated.isDefault).toBe(false);
  });

  it("remove deletes the stored secret and cleans dangling assignments", async () => {
    const { registry, keyring } = createHarness();
    const ep = await registry.add({
      name: "Protected",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });
    await registry.setCredential(ep.id, "sk-secret-value");
    expect(keyring.map.get(ep.id)).toBe("sk-secret-value");

    await registry.setAssignment("coding", ep.id, "qwen2.5-coder");
    await registry.remove(ep.id);

    expect(keyring.map.has(ep.id)).toBe(false);
    expect(await registry.list()).toEqual([]);
    expect(await registry.resolveAssignment("coding")).toBeNull();
  });

  it("removing the default promotes the first remaining enabled endpoint", async () => {
    const { registry } = createHarness();
    const first = await registry.add({
      name: "First",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    const disabled = await registry.add({
      name: "Disabled",
      provider: "llamacpp",
      baseUrl: "http://localhost:8080/v1",
      enabled: false,
    });
    const enabled = await registry.add({
      name: "Second Enabled",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });

    await registry.remove(first.id);
    const list = await registry.list();
    expect(list.find((e) => e.id === disabled.id)?.isDefault).toBe(false);
    expect(list.find((e) => e.id === enabled.id)?.isDefault).toBe(true);
  });

  it("resolveAssignment follows task -> default -> first enabled -> null", async () => {
    const { registry } = createHarness();
    expect(await registry.resolveAssignment("coding")).toBeNull();

    const ep1 = await registry.add({
      name: "First",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    const ep2 = await registry.add({
      name: "Second",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });

    // No assignment yet -> falls back to default endpoint (ep1)
    const fallbackDefault = await registry.resolveAssignment("coding");
    expect(fallbackDefault?.endpoint.id).toBe(ep1.id);

    // Disable ep1 (clears default) -> falls back to first enabled endpoint (ep2)
    await registry.setEnabled(ep1.id, false);
    const fallbackEnabled = await registry.resolveAssignment("coding");
    expect(fallbackEnabled?.endpoint.id).toBe(ep2.id);

    // Explicit default assignment -> beats bare default endpoint
    await registry.setEnabled(ep1.id, true);
    await registry.setAssignment("default", ep1.id, "llama3.1");
    const viaDefaultAssign = await registry.resolveAssignment("coding");
    expect(viaDefaultAssign).toMatchObject({
      endpoint: { id: ep1.id },
      model: "llama3.1",
    });

    // Explicit task assignment -> wins over default
    await registry.setAssignment("coding", ep2.id, "qwen2.5-coder");
    const viaTask = await registry.resolveAssignment("coding");
    expect(viaTask).toMatchObject({
      endpoint: { id: ep2.id },
      model: "qwen2.5-coder",
    });
  });

  it("emits onChange once per successful mutation and zero times on failure", async () => {
    const { registry } = createHarness();
    const listener = vi.fn();
    const unsub = registry.onChange(listener);

    const ep = await registry.add({
      name: "One",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    expect(listener).toHaveBeenCalledTimes(1);

    await expect(
      registry.add({
        name: "one",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
      }),
    ).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);

    await registry.list();
    expect(listener).toHaveBeenCalledTimes(1);

    await registry.update(ep.id, { baseUrl: "http://localhost:11435" });
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    await registry.setEnabled(ep.id, false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("discover passes the stored secret in the Authorization Bearer header", async () => {
    const seenHeaders: Array<HeadersInit | undefined> = [];
    const seenUrls: string[] = [];
    const fetchStub = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrls.push(String(input));
        seenHeaders.push(init?.headers);
        return new Response(
          JSON.stringify({
            data: [{ id: "mlx-qwen", max_model_len: 32768 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ) as typeof fetch;

    const { registry } = createHarness(fetchStub);
    const ep = await registry.add({
      name: "Protected MLX",
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080/v1",
    });
    await registry.setCredential(ep.id, "sk-bearer-xyz");

    const models = await registry.discover(ep.id);
    expect(seenUrls[0]).toBe("http://localhost:8080/v1/models");
    expect(seenHeaders[0]).toMatchObject({
      Authorization: "Bearer sk-bearer-xyz",
    });
    expect(models).toEqual([
      {
        id: "mlx-qwen",
        contextWindow: 32768,
        lastSeenAt: "2026-11-22T05:00:00.000Z",
      },
    ]);
  });

  it("discover returns [] without throwing on an unreachable endpoint and stops at deadline", async () => {
    const hangingFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("Aborted"));
          });
        }),
    ) as typeof fetch;

    const ep = {
      id: "ep_hang",
      name: "Hanging",
      provider: "vllm" as const,
      baseUrl: "http://localhost:8000/v1",
      credential: null,
      enabled: true,
      isDefault: true,
      models: [],
    };

    const start = Date.now();
    const models = await discoverModels(ep, undefined, {
      fetch: hangingFetch,
      now: () => "2026-11-22T05:00:00.000Z",
      discoveryDeadlineMs: 40,
      requestTimeoutMs: 40,
    });
    expect(models).toEqual([]);
    expect(Date.now() - start).toBeLessThan(1000);

    const failingFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { registry } = createHarness(failingFetch);
    const added = await registry.add({
      name: "Down",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    expect(await registry.discover(added.id)).toEqual([]);
  });

  it("testEndpoint reports ok: false on timeout, never healthy", async () => {
    const hangingFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("Timeout"));
          });
        }),
    ) as typeof fetch;

    const result = await testEndpoint(
      {
        id: "ep_slow",
        name: "Slow",
        provider: "openai-compatible",
        baseUrl: "http://localhost:8080/v1",
        credential: null,
        enabled: true,
        isDefault: true,
        models: [],
      },
      undefined,
      {
        fetch: hangingFetch,
        now: () => "2026-11-22T05:00:00.000Z",
        testDeadlineMs: 40,
        requestTimeoutMs: 40,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("two sequential adds persist both endpoints", async () => {
    const { registry, repository } = createHarness();
    await registry.add({
      name: "Ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    await registry.add({
      name: "vLLM",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });

    const reloaded = await repository.read();
    expect(reloaded.endpoints.map((e) => e.name)).toEqual(["Ollama", "vLLM"]);
  });

  it("testEndpoint executes a real authenticated probe for Claude/Gemini and supports inference mode", async () => {
    const calls: Array<{
      url: string;
      method?: string;
      headers?: HeadersInit;
    }> = [];
    const fetchStub = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          headers: init?.headers,
        });
        return new Response(
          JSON.stringify({ data: [{ id: "claude-sonnet-4-20250514" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ) as typeof fetch;

    const claudeEp = {
      id: "ep_claude",
      name: "Claude",
      provider: "claude" as const,
      credential: { kind: "keyring" as const, id: "ep_claude" },
      enabled: true,
      isDefault: true,
      models: [{ id: "claude-sonnet-4-20250514" }],
    };

    const probeRes = await testEndpoint(claudeEp, "sk-ant-real", {
      fetch: fetchStub,
      now: () => "2026-11-22T05:00:00.000Z",
    });
    expect(probeRes.ok).toBe(true);
    expect(probeRes.mode).toBe("connectivity+auth");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0].headers).toMatchObject({
      "x-api-key": "sk-ant-real",
      "anthropic-version": "2023-06-01",
    });

    const infRes = await testEndpoint(
      claudeEp,
      "sk-ant-real",
      {
        fetch: fetchStub,
        now: () => "2026-11-22T05:00:00.000Z",
      },
      { inference: true },
    );
    expect(infRes.ok).toBe(true);
    expect(infRes.mode).toBe("inference");
    expect(calls[1].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[1].method).toBe("POST");
  });
});
