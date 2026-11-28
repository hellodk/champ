import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EndpointRepository } from "@/config/provider-repository";
import type { ProvidersDocument } from "@/config/provider-model";

describe("provider repository routing migration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function repoWithDocument(doc: unknown): EndpointRepository {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-routing-repo-"));
    dirs.push(home);
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".champ", "providers.json"),
      JSON.stringify(doc),
      { mode: 0o600 },
    );
    return new EndpointRepository({ homeDir: home });
  }

  it("preserves v1 endpoints, assignments and credentials unchanged", async () => {
    const legacy: ProvidersDocument = {
      version: 1,
      endpoints: [
        {
          id: "ep_1",
          name: "Local",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          credential: null,
          enabled: true,
          isDefault: true,
          models: [{ id: "llama3.1:8b", contextWindow: 8192 }],
        },
      ],
      assignments: {
        coding: { endpointId: "ep_1", model: "llama3.1:8b" },
      },
      routingMode: "manual",
    };
    const repo = repoWithDocument(legacy);
    const loaded = await repo.read();

    expect(loaded.endpoints).toEqual(legacy.endpoints);
    expect(loaded.assignments).toEqual(legacy.assignments);
    expect(loaded.routingMode).toBe("manual");
    expect(loaded.pools).toBeUndefined();
    expect(loaded.selection).toBeUndefined();
  });

  it("round-trips additive pool and selection fields without secret values", async () => {
    const repo = repoWithDocument({
      version: 1,
      endpoints: [
        {
          id: "ep_1",
          name: "Local",
          provider: "ollama",
          credential: null,
          enabled: true,
          isDefault: true,
          models: [],
        },
      ],
      assignments: {},
      routingMode: "auto",
      pools: [
        {
          id: "pool_local",
          name: "Local models",
          endpointIds: ["ep_1", "ep_missing"],
          routing: { preference: "fast", allowCloud: false },
        },
      ],
      selection: {
        scope: { kind: "pool", poolId: "pool_local" },
        preference: "balanced",
        pinned: null,
      },
    });

    const loaded = await repo.read();
    expect(loaded.pools?.[0]).toMatchObject({
      id: "pool_local",
      endpointIds: ["ep_1"],
      routing: { preference: "fast", allowCloud: false },
    });
    expect(loaded.selection?.scope).toEqual({
      kind: "pool",
      poolId: "pool_local",
    });

    await repo.write(loaded);
    const onDisk = JSON.parse(fs.readFileSync(repo.path(), "utf8"));
    expect(JSON.stringify(onDisk)).not.toContain("apiKey");
    expect(onDisk.pools[0].endpointIds).toEqual(["ep_1"]);
  });

  it("normalizes capability evidence and user overrides on discovered models", async () => {
    const repo = repoWithDocument({
      version: 1,
      endpoints: [
        {
          id: "ep_1",
          name: "Local",
          provider: "ollama",
          credential: null,
          enabled: true,
          isDefault: true,
          models: [
            {
              id: "model-1",
              capabilitySet: { chat: "yes", tools: "guess" },
              capabilityEvidence: {
                chat: {
                  source: "server",
                  observedAt: "2026-01-01T00:00:00.000Z",
                },
              },
              contextWindow: 32_000,
              lastSeenAt: "2026-01-01T00:00:00.000Z",
              qualityHint: 90,
              speedHint: "fast",
              overrides: { pinned: true },
            },
          ],
        },
      ],
      assignments: {},
      routingMode: "auto",
    });

    const loaded = await repo.read();
    const model = loaded.endpoints[0].models[0];
    expect(model.capabilitySet).toEqual({ chat: "yes" });
    expect(model.capabilityEvidence?.chat?.source).toBe("server");
    expect(model.qualityHint).toBe(90);
    expect(model.speedHint).toBe("fast");
    expect(model.overrides).toEqual({ pinned: true });
  });
});
