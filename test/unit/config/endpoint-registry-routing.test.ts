import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EndpointRegistry } from "@/config/endpoint-registry";
import { EndpointRepository } from "@/config/provider-repository";
import type { ProvidersDocument } from "@/config/provider-model";

const emptyCredentials = {
  async get() {
    return undefined;
  },
  async set() {},
  async delete() {},
};

describe("EndpointRegistry canonical routing state", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(doc: ProvidersDocument, discover = vi.fn(async () => [])) {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "champ-registry-route-"),
    );
    dirs.push(home);
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".champ", "providers.json"),
      JSON.stringify(doc),
      {
        mode: 0o600,
      },
    );
    const repository = new EndpointRepository({ homeDir: home });
    const registry = new EndpointRegistry({
      repository,
      credentials: emptyCredentials,
      discovery: {
        discoverModels: discover as never,
        testEndpoint: vi.fn(async () => ({ ok: true })) as never,
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    return { repository, registry, discover };
  }

  const baseDoc = (): ProvidersDocument => ({
    version: 1,
    endpoints: [
      {
        id: "ep_a",
        name: "A",
        provider: "ollama",
        credential: null,
        enabled: true,
        isDefault: true,
        models: [
          {
            id: "m1",
            capabilitySet: { chat: "yes", embeddings: "no" },
            contextWindow: 8192,
          },
        ],
      },
      {
        id: "ep_b",
        name: "B",
        provider: "openai-compatible",
        credential: null,
        enabled: true,
        isDefault: false,
        models: [
          {
            id: "m2",
            capabilitySet: { chat: "yes", embeddings: "no" },
            contextWindow: 8192,
          },
        ],
      },
    ],
    assignments: {},
    routingMode: "auto",
  });

  it("creates, updates and removes named pools with endpoint IDs only", async () => {
    const { registry, repository } = setup(baseDoc());
    const pool = await registry.addPool({
      id: "pool_local",
      name: "Local pool",
      endpointIds: ["ep_a"],
    });
    expect(pool.endpointIds).toEqual(["ep_a"]);

    const updated = await registry.updatePool("pool_local", {
      name: "Renamed",
      endpointIds: ["ep_a", "ep_b"],
      preference: "fast",
      allowCloud: false,
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.endpointIds).toEqual(["ep_a", "ep_b"]);
    expect(updated.routing?.preference).toBe("fast");

    await registry.removePool("pool_local");
    expect((await repository.read()).pools).toEqual([]);
  });

  it("cleans pool references and pinned target but keeps a valid pool scope when an endpoint is deleted", async () => {
    const { registry, repository } = setup(baseDoc());
    await registry.addPool({
      id: "pool_local",
      name: "Local pool",
      endpointIds: ["ep_a", "ep_b"],
    });
    await registry.setSelection({
      scope: { kind: "pool", poolId: "pool_local" },
      preference: "balanced",
      pinned: { endpointId: "ep_a", modelId: "m1" },
    });

    await registry.remove("ep_a");
    const doc = await repository.read();
    expect(doc.pools?.[0].endpointIds).toEqual(["ep_b"]);
    expect(doc.selection?.pinned).toBeNull();
    expect(doc.selection?.scope).toEqual({
      kind: "pool",
      poolId: "pool_local",
    });
  });

  it("resets an emptied pool scope to the safe global default", async () => {
    const { registry, repository } = setup(baseDoc());
    await registry.addPool({
      id: "pool_local",
      name: "Local pool",
      endpointIds: ["ep_a"],
    });
    await registry.setSelection({
      scope: { kind: "pool", poolId: "pool_local" },
      preference: "balanced",
      pinned: null,
    });

    await registry.remove("ep_a");
    const doc = await repository.read();
    expect(doc.selection?.scope).toEqual({ kind: "global", allowCloud: false });
  });

  it("uses the canonical router for resolveRoute and records the decision", async () => {
    const { registry } = setup(baseDoc());
    await registry.setSelection({
      scope: { kind: "endpoint", endpointId: "ep_b" },
      preference: "balanced",
      pinned: null,
    });
    const decision = await registry.resolveRoute({ task: "chat" });
    expect(decision.target).toEqual({ endpointId: "ep_b", modelId: "m2" });
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("does not erase discovered inventory when discovery temporarily fails", async () => {
    const discover = vi.fn(async () => []);
    const { registry, repository } = setup(baseDoc(), discover);
    const before = (await repository.read()).endpoints[0].models;
    const result = await registry.discover("ep_a");
    expect(result).toEqual([]);
    expect((await repository.read()).endpoints[0].models).toEqual(before);
  });
});
