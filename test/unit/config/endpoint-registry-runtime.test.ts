import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EndpointRegistry } from "@/config/endpoint-registry";
import { EndpointRepository } from "@/config/provider-repository";

const credentials = {
  async get() {
    return undefined;
  },
  async set() {},
  async delete() {},
};

describe("EndpointRegistry runtime bridge", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-runtime-"));
    dirs.push(home);
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".champ", "providers.json"),
      JSON.stringify({
        version: 1,
        endpoints: [],
        assignments: {},
        routingMode: "auto",
      }),
      { mode: 0o600 },
    );
    const repository = new EndpointRepository({ homeDir: home });
    const registry = new EndpointRegistry({
      repository,
      credentials,
      discovery: {
        discoverModels: vi.fn(async () => []),
        testEndpoint: vi.fn(async () => ({ ok: true })),
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    return { registry };
  }

  it("tracks in-flight requests and records outcomes by endpoint/model identity", () => {
    const { registry } = setup();
    const target = { endpointId: "ep_a", modelId: "m1" };

    const release = registry.beginRequest(target);
    expect(registry.runtime.get(target)?.inFlight).toBe(1);
    release();
    release();
    expect(registry.runtime.get(target)?.inFlight).toBe(0);

    registry.recordFailure(target, "timeout");
    expect(registry.runtime.get(target)?.lastError).toBe("timeout");
    registry.recordSuccess(target, 120, 45);
    expect(registry.runtime.get(target)?.consecutiveFailures).toBe(0);
    expect(registry.runtime.get(target)?.ttftMs).toBe(45);
    registry.runtime.dispose();
  });
});
