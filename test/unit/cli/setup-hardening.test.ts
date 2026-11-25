/**
 * TDD: `champ setup` hardening — verify the saved endpoint and let the
 * operator assign tasks, without leaking credentials.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { KeyringBackend } from "@/config/credential-store";
import { ChainCredentialStore } from "@/config/credential-store";
import { EndpointRegistry } from "@/config/endpoint-registry";
import { discoverModels, testEndpoint } from "@/config/model-discovery";
import { EndpointRepository } from "@/config/provider-repository";
import {
  formatVerificationLine,
  runSetup,
  type SetupPrompts,
} from "@/cli/setup";

const keyring = (): KeyringBackend => {
  const map = new Map<string, string>();
  return {
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
};

describe("cli setup hardening", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const harness = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-setup-harden-"));
    dirs.push(home);
    const registry = new EndpointRegistry({
      repository: new EndpointRepository({ homeDir: home }),
      credentials: new ChainCredentialStore({ keyring: keyring(), env: {} }),
      discovery: { discoverModels, testEndpoint },
      now: () => "2026-11-23T05:00:00.000Z",
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const lines: string[] = [];
    return { registry, lines };
  };

  it("verifies the saved endpoint and assigns selected tasks", async () => {
    const { registry, lines } = harness();
    const pickTasks = vi.fn(async () => ["coding", "chat"] as const);
    const prompts: SetupPrompts = {
      choose: async () => "vllm",
      input: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:8000/v1")
        .mockResolvedValueOnce("Local vLLM"),
      secret: async () => undefined,
      confirm: async () => true,
      pickModel: async () => "m1",
      pickTasks,
    };

    const result = await runSetup({
      registry,
      prompts,
      writeLine: (line) => lines.push(line),
      probeFetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    expect(result.saved).toBe(true);
    expect(result.verified).toBe(true);
    expect(
      lines.some((line) => /^Verification: connectivity\+auth ok\b/.test(line)),
    ).toBe(true);
    expect(lines.some((line) => /^Verification: ok\b/.test(line))).toBe(false);
    expect(pickTasks).toHaveBeenCalledTimes(1);

    if (!result.endpointId) throw new Error("missing endpoint id");
    expect((await registry.resolveAssignment("coding"))?.endpoint.id).toBe(
      result.endpointId,
    );
    expect((await registry.resolveAssignment("chat"))?.endpoint.id).toBe(
      result.endpointId,
    );
    expect((await registry.resolveAssignment("completion"))?.endpoint.id).toBe(
      result.endpointId,
    );
  });

  it("detects an existing stored key for the selected provider", async () => {
    const { registry } = harness();
    const authFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers.Authorization) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const prompts: SetupPrompts = {
      choose: async () => "openai",
      input: vi
        .fn()
        .mockResolvedValueOnce("https://api.openai.com/v1")
        .mockResolvedValueOnce("gpt-4o")
        .mockResolvedValueOnce("OpenAI primary"),
      secret: async () => "sk-existing",
      confirm: async () => true,
      pickModel: async () => "m1",
    };

    const first = await runSetup({
      registry,
      prompts,
      writeLine: () => {},
      probeFetch: authFetch,
    });
    expect(first.saved).toBe(true);
    expect(await registry.hasStoredCredentialForProvider("openai")).toBe(true);
  });

  it("labels connectivity-only verification explicitly", () => {
    const line = formatVerificationLine({
      ok: true,
      mode: "connectivity+auth",
      statusCode: 200,
      detail: "reachable (use --inference to test generation)",
    });

    expect(line).toMatch(/^Verification: connectivity\+auth ok\b/);
    expect(line).not.toMatch(/^Verification: ok\b/);
  });

  it("labels inference verification as inference", () => {
    const line = formatVerificationLine({
      ok: true,
      mode: "inference",
      statusCode: 200,
      detail: "inference ok (m1)",
    });

    expect(line).toMatch(/^Verification: inference ok\b/);
    expect(line).toContain("inference ok (m1)");
  });
});
