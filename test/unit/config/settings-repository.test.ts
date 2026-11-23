import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChainCredentialStore,
  type KeyringBackend,
} from "@/config/credential-store";
import type { ProvidersDocument } from "@/config/provider-model";
import { EndpointRepository } from "@/config/provider-repository";
import { SettingsRepository } from "@/config/settings-repository";

function makeKeyring(): KeyringBackend & { map: Map<string, string> } {
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

function endpoint(id: string, model: string) {
  return {
    id,
    name: id,
    provider: "openai-compatible" as const,
    baseUrl: "http://localhost:8080/v1",
    credential: null,
    enabled: true,
    isDefault: id === "ep_a",
    models: [{ id: model }],
  };
}

describe("SettingsRepository", () => {
  const dirs: string[] = [];

  function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-settings-"));
    const workspace = path.join(dir, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const configPath = path.join(dir, ".champ", "config.yaml");
    const repository = new EndpointRepository({ homeDir: dir });
    const keyring = makeKeyring();
    const credentials = new ChainCredentialStore({ keyring, env: {} });
    dirs.push(dir);
    return { dir, workspace, configPath, repository, keyring, credentials };
  }

  function writeConfig(configPath: string, text: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, text, "utf8");
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves workspace selection above registry assignments and merges YAML settings", async () => {
    const h = harness();
    writeConfig(
      h.configPath,
      'provider: openai-compatible\nuserRules: "Be terse."\n',
    );
    const doc: ProvidersDocument = {
      version: 1,
      routingMode: "manual",
      endpoints: [endpoint("ep_a", "model-a"), endpoint("ep_b", "model-b")],
      assignments: { default: { endpointId: "ep_a", model: "model-a" } },
    };
    await h.repository.write(doc);
    fs.mkdirSync(path.join(h.workspace, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(h.workspace, ".champ", "provider.json"),
      JSON.stringify({ endpoint: "ep_b", model: "ws-model" }),
    );

    const settings = await new SettingsRepository({
      homeDir: h.dir,
      configPath: h.configPath,
      workspaceDir: h.workspace,
      credentials: h.credentials,
    }).load();

    expect(settings.selection?.endpoint.id).toBe("ep_b");
    expect(settings.selection?.model).toBe("ws-model");
    expect(settings.selection?.source).toBe("workspace");
    expect(settings.config.userRules).toBe("Be terse.");
    expect(settings.sources.yaml).toBe(h.configPath);
  });

  it("reports invalid YAML as a diagnostic instead of throwing", async () => {
    const h = harness();
    writeConfig(h.configPath, "provider: [not-closed\n");

    const settings = await new SettingsRepository({
      homeDir: h.dir,
      configPath: h.configPath,
      credentials: h.credentials,
    }).load();

    expect(settings.config).toEqual({});
    expect(
      settings.diagnostics.some(
        (d) => d.code === "yaml-invalid" && d.level === "error",
      ),
    ).toBe(true);
  });

  it("flags dangling assignments and missing workspace endpoints", async () => {
    const h = harness();
    await h.repository.write({
      version: 1,
      routingMode: "manual",
      endpoints: [endpoint("ep_a", "model-a")],
      assignments: { coding: { endpointId: "gone", model: "m" } },
    });
    fs.mkdirSync(path.join(h.workspace, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(h.workspace, ".champ", "provider.json"),
      JSON.stringify({ endpoint: "also-gone" }),
    );

    const diagnostics = await new SettingsRepository({
      homeDir: h.dir,
      configPath: h.configPath,
      workspaceDir: h.workspace,
      credentials: h.credentials,
    }).validate();

    expect(diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        "assignment-dangling",
        "workspace-endpoint-missing",
      ]),
    );
  });

  it("checks credential availability in doctor", async () => {
    const h = harness();
    const ep = endpoint("ep_a", "model-a");
    await h.repository.write({
      version: 1,
      routingMode: "manual",
      endpoints: [{ ...ep, credential: { kind: "keyring", id: "ep_a" } }],
      assignments: {},
    });

    const repo = new SettingsRepository({
      homeDir: h.dir,
      configPath: h.configPath,
      credentials: h.credentials,
    });
    const before = await repo.doctor();
    expect(before.healthy).toBe(false);
    expect(before.diagnostics.map((d) => d.code)).toContain(
      "credential-missing",
    );

    h.keyring.map.set("ep_a", "secret-token");
    const after = await repo.doctor();
    expect(after.healthy).toBe(true);
  });

  it("exports redacted JSON without secrets or bare credential refs", async () => {
    const h = harness();
    writeConfig(
      h.configPath,
      [
        "provider: openai-compatible",
        "providers:",
        "  openai-compatible:",
        "    apiKey: top-secret",
      ].join("\n"),
    );
    await h.repository.write({
      version: 1,
      routingMode: "manual",
      endpoints: [
        {
          ...endpoint("ep_a", "model-a"),
          credential: { kind: "keyring", id: "ep_a" },
        },
      ],
      assignments: {},
    });

    const exported = await new SettingsRepository({
      homeDir: h.dir,
      configPath: h.configPath,
      credentials: h.credentials,
    }).export({ redact: true });

    expect(exported).not.toContain("top-secret");
    expect(exported).not.toContain('"id":"ep_a"');
    expect(exported).toContain("<redacted>");
    expect(JSON.parse(exported)).toHaveProperty("config");
    expect(JSON.parse(exported)).toHaveProperty("selection");
  });

  it("falls back to the legacy YAML provider block when the registry is empty", async () => {
    const h = harness();
    writeConfig(
      h.configPath,
      [
        "provider: openai-compatible",
        "providers:",
        "  openai-compatible:",
        "    baseUrl: http://localhost:8080/v1",
        "    model: legacy-model",
      ].join("\n"),
    );

    const settings = await new SettingsRepository({
      homeDir: h.dir,
      configPath: h.configPath,
      credentials: h.credentials,
    }).load();

    expect(settings.selection?.endpoint.provider).toBe("openai-compatible");
    expect(settings.selection?.model).toBe("legacy-model");
    expect(
      settings.diagnostics.some((d) => d.code === "legacy-yaml-provider"),
    ).toBe(true);
  });
});
