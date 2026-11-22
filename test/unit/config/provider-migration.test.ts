import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ChainCredentialStore,
  type KeyringBackend,
} from "@/config/credential-store";
import { EndpointRegistry } from "@/config/endpoint-registry";
import { discoverModels, testEndpoint } from "@/config/model-discovery";
import { migrateFromYaml } from "@/config/provider-migration";
import { EndpointRepository } from "@/config/provider-repository";

function makeInMemoryKeyring(available = true): KeyringBackend & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    isAvailable: () => available,
    unavailableReason: () =>
      available ? undefined : "No OS keyring daemon in headless session",
    get: async (id) => map.get(id),
    set: async (id, secret) => {
      map.set(id, secret);
    },
    delete: async (id) => {
      map.delete(id);
    },
  };
}

describe("migrateFromYaml", () => {
  const dirs: string[] = [];

  function setup(keyringAvailable = true) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-mig-test-"));
    dirs.push(home);
    const repository = new EndpointRepository({ homeDir: home });
    const keyring = makeInMemoryKeyring(keyringAvailable);
    const credentials = new ChainCredentialStore({ keyring, env: {} });
    const registry = new EndpointRegistry({
      repository,
      credentials,
      discovery: { discoverModels, testEndpoint },
      now: () => "2026-11-22T06:00:00.000Z",
    });
    return { home, repository, keyring, credentials, registry };
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports two configured providers and preserves assignments without losing metadata", async () => {
    const { registry } = setup();
    const yaml = `
provider: ollama
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:8b
    contextWindow: 16384
  vllm:
    baseUrl: http://localhost:8000/v1
    model: Qwen2.5-Coder-7B
    supportsTools: true
routing:
  coding: Qwen2.5-Coder-7B
`;

    const result = await migrateFromYaml({
      configText: yaml,
      registry,
      credentials: new ChainCredentialStore({
        keyring: makeInMemoryKeyring(true),
        env: {},
      }),
      dryRun: false,
    });

    expect(result.endpoints).toBe(2);
    expect(result.written).toBe(true);

    const endpoints = await registry.list();
    expect(endpoints).toHaveLength(2);
    const ollamaEp = endpoints.find((e) => e.provider === "ollama");
    const vllmEp = endpoints.find((e) => e.provider === "vllm");
    expect(ollamaEp).toMatchObject({
      baseUrl: "http://localhost:11434",
      contextWindow: 16384,
      isDefault: true,
    });
    expect(vllmEp).toMatchObject({
      baseUrl: "http://localhost:8000/v1",
      supportsTools: true,
      isDefault: false,
    });

    const defaultAssign = await registry.resolveAssignment("default");
    expect(defaultAssign?.endpoint.id).toBe(ollamaEp?.id);
    expect(defaultAssign?.model).toBe("qwen3:8b");

    const codingAssign = await registry.resolveAssignment("coding");
    expect(codingAssign?.endpoint.id).toBe(vllmEp?.id);
    expect(codingAssign?.model).toBe("Qwen2.5-Coder-7B");
  });

  it("returns zero endpoints and performs no write when configText is null or empty", async () => {
    const { registry, repository, credentials } = setup();

    const r1 = await migrateFromYaml({
      configText: null,
      registry,
      credentials,
      dryRun: false,
    });
    expect(r1).toEqual({ endpoints: 0, warnings: [], written: false });
    expect(fs.existsSync(repository.path())).toBe(false);
  });

  it("moves self-hosted inline apiKey to keyring and never writes it to providers.json", async () => {
    const { registry, repository, keyring, credentials } = setup(true);
    const secret = "sk-inline-yaml-secret-777";
    const yaml = `
provider: vllm
providers:
  vllm:
    baseUrl: http://localhost:8000/v1
    model: local-coder
    apiKey: ${secret}
`;

    const result = await migrateFromYaml({
      configText: yaml,
      registry,
      credentials,
      dryRun: false,
    });
    expect(result.endpoints).toBe(1);
    const jsonRaw = fs.readFileSync(repository.path(), "utf8");
    expect(jsonRaw).not.toContain(secret);
    const ep = (await registry.list())[0];
    expect(ep.credential).toEqual({
      kind: "keyring",
      id: "champ.vllm.apiKey",
    });
    expect(keyring.map.get("champ.vllm.apiKey")).toBe(secret);
  });

  it("warns with env var name when self-hosted apiKey cannot be stored in unavailable keyring", async () => {
    const { registry, repository, credentials } = setup(false);
    const secret = "sk-headless-yaml-secret";
    const yaml = `
provider: vllm
providers:
  vllm:
    baseUrl: http://localhost:8000/v1
    model: local-coder
    apiKey: ${secret}
`;

    const result = await migrateFromYaml({
      configText: yaml,
      registry,
      credentials,
      dryRun: false,
    });
    expect(result.endpoints).toBe(1);
    expect(result.warnings.some((w) => w.includes("VLLM_API_KEY"))).toBe(true);
    expect(fs.readFileSync(repository.path(), "utf8")).not.toContain(secret);
  });

  it("creates keyring ref and emits explicit recovery warning for cloud providers", async () => {
    const { registry, credentials } = setup(true);
    const yaml = `
provider: claude
providers:
  claude:
    model: claude-sonnet-4-20250514
`;

    const result = await migrateFromYaml({
      configText: yaml,
      registry,
      credentials,
      dryRun: false,
    });
    expect(result.endpoints).toBe(1);
    const ep = (await registry.list())[0];
    expect(ep.credential).toEqual({
      kind: "keyring",
      id: "champ.claude.apiKey",
    });
    expect(result.warnings.some((w) => w.includes("champ.claude.apiKey"))).toBe(
      true,
    );
  });

  it("is idempotent on a second run", async () => {
    const { registry, credentials } = setup(true);
    const yaml = `
provider: ollama
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1
`;

    const first = await migrateFromYaml({
      configText: yaml,
      registry,
      credentials,
      dryRun: false,
    });
    expect(first.endpoints).toBe(1);
    expect(first.written).toBe(true);

    const second = await migrateFromYaml({
      configText: yaml,
      registry,
      credentials,
      dryRun: false,
    });
    expect(second.endpoints).toBe(0);
    expect(second.written).toBe(false);
    expect(await registry.list()).toHaveLength(1);
  });

  it("--dry-run writes nothing", async () => {
    const { registry, repository, credentials } = setup(true);
    const yaml = `
provider: ollama
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1
`;

    const result = await migrateFromYaml({
      configText: yaml,
      registry,
      credentials,
      dryRun: true,
    });

    expect(result.endpoints).toBe(1);
    expect(result.written).toBe(false);
    expect(fs.existsSync(repository.path())).toBe(false);
    expect(await registry.list()).toEqual([]);
  });

  it("returns a warning and does not crash on malformed YAML", async () => {
    const { registry, credentials } = setup(true);
    const result = await migrateFromYaml({
      configText: "provider: [broken yaml",
      registry,
      credentials,
      dryRun: false,
    });

    expect(result.endpoints).toBe(0);
    expect(result.written).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
