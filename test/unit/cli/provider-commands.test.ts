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
import { SettingsRepository } from "@/config/settings-repository";
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

    const settings = new SettingsRepository({
      homeDir: home,
      configPath: path.join(home, ".champ", "config.yaml"),
      workspaceDir: workspace,
      credentials,
      repository,
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
      settings,
      out,
      err,
      deps: {
        registry,
        credentials,
        settings,
        cwd: workspace,
        stdout: (s: string) => out.push(s),
        stderr: (s: string) => err.push(s),
      },
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
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
    expect(JSON.parse(text)).toHaveProperty("config");
    expect(JSON.parse(text)).toHaveProperty("selection");
  });

  it("config show includes effective settings from both stores", async () => {
    const { deps, out, home } = createCmdHarness();
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".champ", "config.yaml"),
      'userRules: "Be terse."\n',
    );

    const code = await runProviderCommand({ name: "config-show" }, deps);
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).config.userRules).toBe("Be terse.");
  });

  it("config set provider updates the effective registry assignment", async () => {
    const { deps, registry, home } = createCmdHarness();
    const configPath = path.join(home, ".champ", "config.yaml");
    vi.stubEnv("CHAMP_CONFIG", configPath);
    const old = await registry.add({
      name: "Old",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      models: [{ id: "old-model" }],
    });
    await registry.setAssignment("default", old.id, "old-model");
    await registry.add({
      name: "New",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      models: [{ id: "new-model" }],
    });

    const code = await runProviderCommand(
      { name: "config-set", key: "provider", value: "ollama" },
      deps,
    );

    expect(code).toBe(0);
    const assignment = await registry.resolveAssignment("default");
    expect(assignment?.endpoint.provider).toBe("ollama");
    expect(fs.readFileSync(configPath, "utf8")).toMatch(/^provider: ollama$/m);
  });

  it("config show reports the effective provider source", async () => {
    const { deps, registry, out } = createCmdHarness();
    const ep = await registry.add({
      name: "Active",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      models: [{ id: "active-model" }],
    });
    await registry.setAssignment("default", ep.id, "active-model");

    const code = await runProviderCommand({ name: "config-show" }, deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      effective?: { provider?: string; model?: string; source?: string };
      selection?: { source?: string };
    };
    expect(parsed.effective?.provider).toBe("vllm");
    expect(parsed.effective?.model).toBe("active-model");
    expect(parsed.effective?.source).toBeTruthy();
    expect(parsed.effective?.source).toBe(parsed.selection?.source);
  });

  it("config validate reports invalid YAML and exits 1", async () => {
    const { deps, home, out } = createCmdHarness();
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".champ", "config.yaml"),
      "provider: [bad\n",
    );

    const code = await runProviderCommand({ name: "config-validate" }, deps);
    expect(code).toBe(1);
    expect(out.join("")).toContain("yaml-invalid");
  });

  it("config doctor fails when the active credential is missing", async () => {
    const { deps, registry, out } = createCmdHarness();
    await registry.add({
      name: "NeedsKey",
      provider: "openai",
      credential: { kind: "keyring", id: "ep_missing" },
    });

    const code = await runProviderCommand({ name: "config-doctor" }, deps);
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("credentials");
    expect(text).toContain("credential-missing");
  });

  it("config export requires --redact and never prints secrets", async () => {
    const { deps, home, out, err } = createCmdHarness();
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".champ", "config.yaml"),
      [
        "provider: openai-compatible",
        "providers:",
        "  openai-compatible:",
        "    apiKey: never-export-me",
      ].join("\n"),
    );

    const refused = await runProviderCommand(
      { name: "config-export", redact: false },
      deps,
    );
    expect(refused).toBe(2);
    expect(err.join("")).toContain("--redact");

    const code = await runProviderCommand(
      { name: "config-export", redact: true },
      deps,
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).not.toContain("never-export-me");
    expect(JSON.parse(text)).toHaveProperty("config");
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

  it("model smart clears the pin while preserving scope", async () => {
    const { deps, registry } = createCmdHarness();
    const ep = await registry.add({
      name: "Local Ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      models: [{ id: "llama3.1" }],
    });
    await registry.setSelection({
      scope: { kind: "endpoint", endpointId: ep.id },
      pinned: { endpointId: ep.id, modelId: "llama3.1" },
      preference: "balanced",
    });

    const code = await runProviderCommand(
      { name: "model-smart", preference: "quality" },
      deps,
    );
    expect(code).toBe(0);
    const selection = await registry.getSelection();
    expect(selection).toMatchObject({
      scope: { kind: "endpoint", endpointId: ep.id },
      preference: "quality",
    });
    expect(selection?.pinned).toBeNull();
  });

  it("model scope requires explicit opt-in for global cloud routing", async () => {
    const { deps, registry } = createCmdHarness();
    await registry.add({
      name: "Cloud",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-4o-mini" }],
    });

    const denied = await runProviderCommand(
      { name: "model-scope", scope: "global" },
      deps,
    );
    expect(denied).toBe(0);
    expect((await registry.getSelection())?.scope).toEqual({
      kind: "global",
      allowCloud: false,
    });

    const allowed = await runProviderCommand(
      { name: "model-scope", scope: "global", allowCloud: true },
      deps,
    );
    expect(allowed).toBe(0);
    expect((await registry.getSelection())?.scope).toEqual({
      kind: "global",
      allowCloud: true,
    });
  });

  it("model pool add creates a selectable pool", async () => {
    const { deps, registry, out } = createCmdHarness();
    const first = await registry.add({
      name: "Local A",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      models: [{ id: "m1" }],
    });
    const second = await registry.add({
      name: "Local B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      models: [{ id: "m2" }],
    });

    const code = await runProviderCommand(
      {
        name: "model-pool-add",
        poolName: "Local pool",
        endpointIds: [first.id, second.id],
      },
      deps,
    );
    expect(code).toBe(0);
    const pool = (await registry.listPools())[0];
    expect(pool.endpointIds).toEqual([first.id, second.id]);
    expect(out.join("")).toContain(pool.id);

    const scopeCode = await runProviderCommand(
      { name: "model-scope", scope: "pool", id: pool.id },
      deps,
    );
    expect(scopeCode).toBe(0);
    expect((await registry.getSelection())?.scope).toEqual({
      kind: "pool",
      poolId: pool.id,
    });
  });

  it("model failover on/off persists an explicit opt-in policy", async () => {
    const { deps, registry, out } = createCmdHarness();
    const endpoint = await registry.add({
      name: "Failover EP",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      models: [{ id: "m1" }],
    });

    expect(
      await runProviderCommand(
        { name: "model-failover", enabled: true, maxAttempts: 2 },
        deps,
      ),
    ).toBe(0);
    expect((await registry.getSelection())?.failover).toEqual({
      enabled: true,
      maxAttempts: 2,
    });
    expect(out.join("")).toContain("Safe failover enabled");

    expect(
      await runProviderCommand(
        { name: "model-failover", enabled: false },
        deps,
      ),
    ).toBe(0);
    expect((await registry.getSelection())?.failover).toBeUndefined();
    expect((await registry.getSelection())?.scope).toEqual({
      kind: "endpoint",
      endpointId: endpoint.id,
    });
  });

  it("model scope preserves an enabled failover policy", async () => {
    const { deps, registry } = createCmdHarness();
    await registry.setSelection({
      scope: { kind: "global", allowCloud: false },
      preference: "quality",
      pinned: null,
      failover: { enabled: true, maxAttempts: 2 },
    });
    await runProviderCommand({ name: "model-scope", scope: "global" }, deps);
    expect((await registry.getSelection())?.failover).toEqual({
      enabled: true,
      maxAttempts: 2,
    });
  });

  it("models --details shows pinned status, evidence, context and runtime status", async () => {
    const { deps, registry, out } = createCmdHarness();
    const ep = await registry.add({
      name: "Local Ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      models: [
        {
          id: "llama3.1",
          contextWindow: 8192,
          lastSeenAt: "2026-11-28T00:00:00.000Z",
          capabilitySet: { chat: "yes", tools: "no" },
          capabilityEvidence: {
            chat: { source: "probe", observedAt: "2026-11-28T00:00:00.000Z" },
          },
        },
      ],
    });
    await registry.setSelection({
      scope: { kind: "endpoint", endpointId: ep.id },
      preference: "balanced",
      pinned: { endpointId: ep.id, modelId: "llama3.1" },
    });

    const code = await runProviderCommand(
      { name: "models", details: true },
      deps,
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain(
      `Selection: scope=endpoint pinned=${ep.id}/llama3.1 preference=balanced`,
    );
    expect(text).toContain(`${ep.id}/llama3.1`);
    expect(text).toContain("name=Local Ollama");
    expect(text).toContain("ctx=8192");
    expect(text).toContain("evidence=chat:probe");
    expect(text).toContain("status=");
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
