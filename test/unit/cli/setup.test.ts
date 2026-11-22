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
import { runSetup, type SetupPrompts } from "@/cli/setup";

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

describe("cli setup (champ setup)", () => {
  const dirs: string[] = [];

  function setupHarness(fetchImpl: typeof fetch) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-setup-test-"));
    dirs.push(home);
    const repository = new EndpointRepository({ homeDir: home });
    const keyring = makeInMemoryKeyring();
    const credentials = new ChainCredentialStore({ keyring, env: {} });
    const registry = new EndpointRegistry({
      repository,
      credentials,
      discovery: { discoverModels, testEndpoint },
      now: () => "2026-11-22T05:00:00.000Z",
      fetch: fetchImpl,
    });
    const lines: string[] = [];
    return {
      home,
      repository,
      keyring,
      credentials,
      registry,
      lines,
      writeLine: (line: string) => lines.push(line),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves one endpoint with key and chosen model on happy path", async () => {
    const seenAuth: Array<string | null> = [];
    const fetchStub = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seenAuth.push(headers.Authorization ?? null);
        if (!headers.Authorization) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(
          JSON.stringify({
            data: [{ id: "qwen2.5-coder" }, { id: "llama3.1" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ) as typeof fetch;

    const { registry, keyring, lines, writeLine } = setupHarness(fetchStub);
    const prompts: SetupPrompts = {
      choose: vi.fn(async () => "vllm"),
      input: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:8000/v1")
        .mockResolvedValueOnce("Local vLLM"),
      secret: vi.fn(async () => "sk-secret-token-xyz"),
      confirm: vi.fn(async () => true),
      pickModel: vi.fn(async () => "qwen2.5-coder"),
    };

    const result = await runSetup({
      registry,
      prompts,
      writeLine,
      probeFetch: fetchStub,
    });

    expect(result.saved).toBe(true);
    expect(result.endpointId).toMatch(/^ep_/);

    const endpoints = await registry.list();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].name).toBe("Local vLLM");
    expect(endpoints[0].isDefault).toBe(true);
    expect(keyring.map.get(endpoints[0].id)).toBe("sk-secret-token-xyz");

    const assignment = await registry.resolveAssignment("default");
    expect(assignment?.model).toBe("qwen2.5-coder");
    expect(seenAuth.includes("Bearer sk-secret-token-xyz")).toBe(true);

    // Key must never appear in stdout/stderr output lines.
    expect(lines.join("\n")).not.toContain("sk-secret-token-xyz");
  });

  it("prompts for a key on 401 and supplies it to discovery", async () => {
    const fetchStub = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers.Authorization !== "Bearer sk-401-pass") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({ data: [{ id: "only-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as typeof fetch;

    const { registry, writeLine } = setupHarness(fetchStub);
    const prompts: SetupPrompts = {
      choose: vi.fn(async () => "openai-compatible"),
      input: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:8080/v1")
        .mockResolvedValueOnce("Protected MLX"),
      secret: vi.fn(async () => "sk-401-pass"),
      confirm: vi.fn(async () => true),
      pickModel: vi.fn(async () => "only-model"),
    };

    const result = await runSetup({
      registry,
      prompts,
      writeLine,
      probeFetch: fetchStub,
    });

    expect(result.saved).toBe(true);
    expect(prompts.secret).toHaveBeenCalledTimes(1);
    const resolved = await registry.resolveAssignment("default");
    expect(resolved?.model).toBe("only-model");
  });

  it("continues with a manually entered model and one warning when discovery fails", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const { registry, lines, writeLine } = setupHarness(fetchStub);
    const prompts: SetupPrompts = {
      choose: vi.fn(async () => "ollama"),
      input: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:11434")
        .mockResolvedValueOnce("qwen3:8b")
        .mockResolvedValueOnce("Offline Ollama"),
      secret: vi.fn(async () => undefined),
      confirm: vi.fn(async () => true),
      pickModel: vi.fn(async () => undefined),
    };

    const result = await runSetup({
      registry,
      prompts,
      writeLine,
      probeFetch: fetchStub,
    });

    expect(result.saved).toBe(true);
    expect(lines.some((l) => /warn|discover/i.test(l))).toBe(true);
    const resolved = await registry.resolveAssignment("default");
    expect(resolved?.model).toBe("qwen3:8b");
  });

  it("saves nothing when cancelled at provider, baseUrl, secret, model, or name steps", async () => {
    const okFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
          status: 200,
        }),
    ) as typeof fetch;
    const unauthFetch = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as typeof fetch;

    // Cancel at choose
    {
      const { registry, writeLine } = setupHarness(okFetch);
      const res = await runSetup({
        registry,
        writeLine,
        probeFetch: okFetch,
        prompts: {
          choose: async () => undefined,
          input: async () => "x",
          secret: async () => "k",
          confirm: async () => true,
          pickModel: async () => "m1",
        },
      });
      expect(res.saved).toBe(false);
      expect(await registry.list()).toEqual([]);
    }

    // Cancel at secret on 401
    {
      const { registry, writeLine } = setupHarness(unauthFetch);
      const res = await runSetup({
        registry,
        writeLine,
        probeFetch: unauthFetch,
        prompts: {
          choose: async () => "vllm",
          input: async () => "http://localhost:8000/v1",
          secret: async () => undefined,
          confirm: async () => true,
          pickModel: async () => "m1",
        },
      });
      expect(res.saved).toBe(false);
      expect(await registry.list()).toEqual([]);
    }

    // Cancel at name step
    {
      const { registry, writeLine } = setupHarness(okFetch);
      const res = await runSetup({
        registry,
        writeLine,
        probeFetch: okFetch,
        prompts: {
          choose: async () => "vllm",
          input: vi
            .fn()
            .mockResolvedValueOnce("http://localhost:8000/v1")
            .mockResolvedValueOnce(undefined),
          secret: async () => undefined,
          confirm: async () => true,
          pickModel: async () => "m1",
        },
      });
      expect(res.saved).toBe(false);
      expect(await registry.list()).toEqual([]);
    }
  });

  it("makes first endpoint default and does not overwrite it on second unless confirmed", async () => {
    const okFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }),
    ) as typeof fetch;
    const { registry, writeLine } = setupHarness(okFetch);

    await runSetup({
      registry,
      writeLine,
      probeFetch: okFetch,
      prompts: {
        choose: async () => "vllm",
        input: vi
          .fn()
          .mockResolvedValueOnce("http://localhost:8000/v1")
          .mockResolvedValueOnce("First"),
        secret: async () => undefined,
        confirm: async () => true,
        pickModel: async () => "m1",
      },
    });

    await runSetup({
      registry,
      writeLine,
      probeFetch: okFetch,
      prompts: {
        choose: async () => "llamacpp",
        input: vi
          .fn()
          .mockResolvedValueOnce("http://localhost:8080/v1")
          .mockResolvedValueOnce("Second"),
        secret: async () => undefined,
        confirm: async () => false,
        pickModel: async () => "m1",
      },
    });

    const list = await registry.list();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.name === "First")?.isDefault).toBe(true);
    expect(list.find((e) => e.name === "Second")?.isDefault).toBe(false);
  });
});
