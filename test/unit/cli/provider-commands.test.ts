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
import { runProviderCommand } from "@/cli/provider-commands";

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

describe("cli provider commands", () => {
  const dirs: string[] = [];

  function createCmdHarness(fetchImpl?: typeof fetch) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-cmd-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "champ-cmd-ws-"));
    dirs.push(home, workspace);

    const repository = new EndpointRepository({ homeDir: home });
    const keyring = makeInMemoryKeyring();
    const credentials = new ChainCredentialStore({ keyring, env: {} });
    const mockFetch: typeof fetch =
      fetchImpl ??
      (vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
            status: 200,
          }),
      ) as typeof fetch);
    const registry = new EndpointRegistry({
      repository,
      credentials,
      discovery: { discoverModels, testEndpoint },
      now: () => "2026-11-22T05:00:00.000Z",
      fetch: mockFetch,
    });

    const out: string[] = [];
    const err: string[] = [];
    return {
      home,
      workspace,
      repository,
      keyring,
      credentials,
      registry,
      out,
      err,
      deps: {
        registry,
        credentials,
        cwd: workspace,
        stdout: (s: string) => out.push(s),
        stderr: (s: string) => err.push(s),
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("provider list prints names, kinds, sources, and hasCredential without leaking keys", async () => {
    const { deps, registry, out } = createCmdHarness();
    const ep = await registry.add({
      name: "Work vLLM",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });
    await registry.setCredential(ep.id, "sk-super-secret-value");

    const code = await runProviderCommand({ name: "provider-list" }, deps);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Work vLLM");
    expect(text).toContain("vllm");
    expect(text).toContain("http://localhost:8000/v1");
    expect(text).toMatch(/hasCredential=true|credential=yes|yes/i);
    expect(text).not.toContain("sk-super-secret-value");
  });

  it("provider remove reports dangling assignment cleanup", async () => {
    const { deps, registry, out } = createCmdHarness();
    const ep = await registry.add({
      name: "Temp",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    await registry.setAssignment("coding", ep.id, "llama3.1");

    const code = await runProviderCommand(
      { name: "provider-remove", id: ep.id },
      deps,
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/cleared.*assignment|coding/i);
  });

  it("models on an unreachable endpoint exits 0 with a warning and no stack trace", async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { deps, registry, err } = createCmdHarness(failingFetch);
    await registry.add({
      name: "Down Server",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });

    const code = await runProviderCommand({ name: "models" }, deps);
    expect(code).toBe(0);
    const errText = err.join("");
    expect(errText).toMatch(/no models|unreachable|warning/i);
    expect(errText).not.toMatch(/^\s+at\s+/m);
  });

  it("config show redacts env and keyring refs", async () => {
    const { deps, registry, out } = createCmdHarness();
    const ep1 = await registry.add({
      name: "KeyringEP",
      provider: "openai",
      credential: { kind: "keyring", id: "champ.openai.apiKey" },
    });
    await registry.setCredential(ep1.id, "sk-never-printed-1");
    await registry.add({
      name: "EnvEP",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      credential: { kind: "env", name: "VLLM_TOKEN" },
    });

    const code = await runProviderCommand({ name: "config-show" }, deps);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("<keyring:champ.openai.apiKey>");
    expect(text).toContain("<env:VLLM_TOKEN>");
    expect(text).not.toContain("sk-never-printed-1");
  });

  it("config migrate --dry-run writes nothing", async () => {
    const { deps, repository } = createCmdHarness();
    const migrate = vi.fn(async ({ dryRun }: { dryRun: boolean }) => ({
      endpoints: 1,
      warnings: [],
      written: !dryRun && false,
    }));

    const code = await runProviderCommand(
      { name: "config-migrate", dryRun: true },
      { ...deps, migrate },
    );
    expect(code).toBe(0);
    expect(migrate).toHaveBeenCalledWith({ dryRun: true });
    expect(fs.existsSync(repository.path())).toBe(false);
  });

  it("model use --workspace writes only non-secret endpoint reference", async () => {
    const { deps, registry, workspace } = createCmdHarness();
    const ep = await registry.add({
      name: "Local MLX",
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080/v1",
    });
    await registry.setCredential(ep.id, "sk-workspace-must-not-see");

    const code = await runProviderCommand(
      {
        name: "model-use",
        endpointAndModel: `${ep.id}/mlx-community/Qwen2.5-Coder`,
        workspace: true,
      },
      deps,
    );
    expect(code).toBe(0);

    const refPath = path.join(workspace, ".champ", "provider.json");
    const parsed = JSON.parse(fs.readFileSync(refPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({
      endpoint: ep.id,
      model: "mlx-community/Qwen2.5-Coder",
    });
    expect(JSON.stringify(parsed)).not.toContain("sk-workspace-must-not-see");
    expect(JSON.stringify(parsed)).not.toContain("localhost");
  });

  it("model assign and config routing update tasks and routingMode", async () => {
    const { deps, registry, out } = createCmdHarness();
    const ep = await registry.add({
      name: "Work vLLM",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
    });

    const assignCode = await runProviderCommand(
      {
        name: "model-assign",
        task: "coding",
        endpointAndModel: `${ep.id}/qwen2.5-coder`,
      },
      deps,
    );
    expect(assignCode).toBe(0);
    expect((await registry.resolveAssignment("coding"))?.model).toBe(
      "qwen2.5-coder",
    );

    const routingCode = await runProviderCommand(
      { name: "config-routing", mode: "manual" },
      deps,
    );
    expect(routingCode).toBe(0);
    expect((await registry.readDocument()).routingMode).toBe("manual");
    expect(out.join("")).toContain('Routing mode set to "manual"');
  });

  it("provider test supports --inference mode", async () => {
    const { deps, registry, out } = createCmdHarness();
    const ep = await registry.add({
      name: "Inference EP",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      models: [{ id: "qwen2.5-coder" }],
    });

    const code = await runProviderCommand(
      { name: "provider-test", id: ep.id, inference: true },
      deps,
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("[inference]");
    expect(out.join("")).toContain("inference ok (qwen2.5-coder)");
  });
});
