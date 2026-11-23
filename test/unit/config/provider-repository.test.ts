import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ProvidersDocument } from "@/config/provider-model";
import {
  EndpointRepository,
  InvalidProvidersDocumentError,
  LockTimeoutError,
  UnsupportedProvidersVersionError,
} from "@/config/provider-repository";

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "champ-repo-test-"));
}

describe("EndpointRepository", () => {
  const dirs: string[] = [];

  function freshHome(): string {
    const dir = makeTmpHome();
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Ensure tests never accidentally touch the caller's real home dir.
  });

  it("returns an empty v1 document when providers.json is absent without creating files", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });

    const doc = await repo.read();

    expect(doc).toEqual({
      version: 1,
      endpoints: [],
      assignments: {},
      routingMode: "auto",
    });
    expect(fs.existsSync(repo.path())).toBe(false);
    expect(fs.existsSync(path.join(home, ".champ"))).toBe(false);
  });

  it("round-trips endpoints, assignments, and routingMode cleanly", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });
    const doc: ProvidersDocument = {
      version: 1,
      endpoints: [
        {
          id: "ep_local01",
          name: "Local MLX",
          provider: "openai-compatible",
          baseUrl: "http://localhost:8080/v1",
          credential: { kind: "keyring", id: "ep_local01" },
          enabled: true,
          isDefault: true,
          supportsTools: true,
          contextWindow: 32768,
          maxTokens: 4096,
          options: { temperature: 0.2 },
          models: [
            {
              id: "qwen2.5-coder",
              displayName: "Qwen 2.5 Coder",
              capabilities: ["chat", "tools"],
              contextWindow: 32768,
              lastSeenAt: "2026-11-22T00:00:00.000Z",
            },
          ],
          lastDiscoveredAt: "2026-11-22T00:00:00.000Z",
        },
        {
          id: "ep_env002",
          name: "OpenAI",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          credential: { kind: "env", name: "OPENAI_API_KEY" },
          enabled: true,
          isDefault: false,
          models: [],
        },
      ],
      assignments: {
        default: { endpointId: "ep_local01", model: "qwen2.5-coder" },
        coding: { endpointId: "ep_local01", model: "qwen2.5-coder" },
      },
      routingMode: "manual",
    };

    await repo.write(doc);
    const readBack = await repo.read();

    expect(readBack).toEqual(doc);
  });

  it("throws a typed error naming both found and supported versions for unknown version and leaves file untouched", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });
    const champDir = path.join(home, ".champ");
    fs.mkdirSync(champDir, { recursive: true });
    const futureJson = JSON.stringify({
      version: 99,
      endpoints: [],
      assignments: {},
      routingMode: "auto",
    });
    fs.writeFileSync(repo.path(), futureJson, "utf8");

    await expect(repo.read()).rejects.toThrowError(
      UnsupportedProvidersVersionError,
    );
    await expect(repo.read()).rejects.toThrow(/99.*1|1.*99/);
    expect(fs.readFileSync(repo.path(), "utf8")).toBe(futureJson);
  });

  it("throws a typed error on malformed JSON", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(repo.path(), "{not-json", "utf8");

    await expect(repo.read()).rejects.toThrowError(
      InvalidProvidersDocumentError,
    );
  });

  it("skips a malformed endpoint with a warning while preserving valid ones", async () => {
    const home = freshHome();
    const warnings: string[] = [];
    const repo = new EndpointRepository({
      homeDir: home,
      warn: (msg) => warnings.push(msg),
    });
    fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
    fs.writeFileSync(
      repo.path(),
      JSON.stringify({
        version: 1,
        endpoints: [
          {
            id: "ep_valid",
            name: "Valid Ollama",
            provider: "ollama",
            baseUrl: "http://localhost:11434",
            credential: null,
            enabled: true,
            isDefault: true,
            models: [],
          },
          {
            id: "ep_bad",
            name: "Broken Provider",
            provider: "not-a-provider",
            credential: null,
            enabled: true,
            isDefault: false,
            models: [],
          },
          {
            id: "ep_bad_cred",
            name: "Broken Cred",
            provider: "openai",
            credential: { kind: "keyring" }, // missing id
            enabled: true,
            isDefault: false,
            models: [],
          },
        ],
        assignments: {},
        routingMode: "auto",
      }),
      "utf8",
    );

    const doc = await repo.read();

    expect(doc.endpoints).toHaveLength(1);
    expect(doc.endpoints[0].id).toBe("ep_valid");
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("writes atomically so a simulated mid-write failure leaves existing file intact", async () => {
    const home = freshHome();
    const initialRepo = new EndpointRepository({ homeDir: home });
    const originalDoc: ProvidersDocument = {
      version: 1,
      endpoints: [
        {
          id: "ep_keep",
          name: "Keep Me",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          credential: null,
          enabled: true,
          isDefault: true,
          models: [],
        },
      ],
      assignments: {},
      routingMode: "auto",
    };
    await initialRepo.write(originalDoc);
    const originalRaw = fs.readFileSync(initialRepo.path(), "utf8");

    const failingRepo = new EndpointRepository({
      homeDir: home,
      onBeforeRename: async () => {
        throw new Error("simulated disk failure");
      },
    });

    await expect(
      failingRepo.write({
        version: 1,
        endpoints: [],
        assignments: {},
        routingMode: "manual",
      }),
    ).rejects.toThrow("simulated disk failure");

    expect(fs.readFileSync(initialRepo.path(), "utf8")).toBe(originalRaw);
    const leftoverTemps = fs
      .readdirSync(path.join(home, ".champ"))
      .filter((f) => f.includes(".tmp."));
    expect(leftoverTemps).toEqual([]);
  });

  it("creates ~/.champ with mode 0700 and providers.json with mode 0600 on first write", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });
    const champDir = path.join(home, ".champ");

    expect(fs.existsSync(champDir)).toBe(false);
    expect(fs.existsSync(repo.path())).toBe(false);

    await repo.write({
      version: 1,
      endpoints: [],
      assignments: {},
      routingMode: "auto",
    });

    // Windows does not implement POSIX permission bits on these calls.
    if (process.platform !== "win32") {
      const dirMode = fs.statSync(champDir).mode & 0o777;
      const fileMode = fs.statSync(repo.path()).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }
  });

  it("refuses to write through a symlink at providers.json or ~/.champ", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });
    const champDir = path.join(home, ".champ");
    fs.mkdirSync(champDir, { recursive: true });
    const targetFile = path.join(home, "victim.txt");
    fs.writeFileSync(targetFile, "untouched", "utf8");
    fs.symlinkSync(targetFile, repo.path());

    await expect(
      repo.write({
        version: 1,
        endpoints: [],
        assignments: {},
        routingMode: "auto",
      }),
    ).rejects.toThrow(/symlink/i);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("untouched");
  });

  it("serializes concurrent withLock calls so updates are never lost", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });

    const addOne = async (idx: number) => {
      await repo.withLock(async () => {
        const doc = await repo.read();
        // Artificial async gap to maximize interleaving pressure if un-locked.
        await new Promise((r) => setTimeout(r, 15));
        doc.endpoints.push({
          id: `ep_${idx}`,
          name: `Endpoint ${idx}`,
          provider: "ollama",
          baseUrl: `http://localhost:${11430 + idx}`,
          credential: null,
          enabled: true,
          isDefault: doc.endpoints.length === 0,
          models: [],
        });
        await repo.write(doc);
      });
    };

    await Promise.all([addOne(1), addOne(2), addOne(3), addOne(4)]);

    const finalDoc = await repo.read();
    expect(finalDoc.endpoints.map((e) => e.id).sort()).toEqual([
      "ep_1",
      "ep_2",
      "ep_3",
      "ep_4",
    ]);
  });

  it("reclaims a stale lock older than 30s and rejects when active lock times out", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });
    const champDir = path.join(home, ".champ");
    fs.mkdirSync(champDir, { recursive: true });
    const lockDir = `${repo.path()}.lock`;
    fs.mkdirSync(lockDir);
    // Backdate mtime by 35 seconds.
    const oldTime = new Date(Date.now() - 35_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    let ran = false;
    await repo.withLock(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);

    // Fresh lock should time out when held longer than timeoutMs.
    fs.mkdirSync(lockDir);
    await expect(repo.withLock(async () => {}, 80)).rejects.toThrowError(
      LockTimeoutError,
    );
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("never resolves default home directory when homeDir is injected", async () => {
    const resolveHomeDir = vi.fn(() => {
      throw new Error("default homeDir resolver must not be called");
    });
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home, resolveHomeDir });

    expect(repo.path()).toBe(path.join(home, ".champ", "providers.json"));
    await repo.write({
      version: 1,
      endpoints: [],
      assignments: {},
      routingMode: "auto",
    });
    const doc = await repo.read();
    expect(doc.endpoints).toEqual([]);
    expect(resolveHomeDir).not.toHaveBeenCalled();
  });

  it("never writes unexpected apiKey fields into providers.json", async () => {
    const home = freshHome();
    const repo = new EndpointRepository({ homeDir: home });
    const secretValue = "sk-should-never-appear-on-disk";
    const sneakyEndpoint = {
      id: "ep_sneaky",
      name: "OpenAI",
      provider: "openai" as const,
      baseUrl: "https://api.openai.com/v1",
      credential: { kind: "keyring" as const, id: "champ.openai.apiKey" },
      enabled: true,
      isDefault: true,
      models: [],
      apiKey: secretValue,
    };

    await repo.write({
      version: 1,
      endpoints: [sneakyEndpoint],
      assignments: {},
      routingMode: "auto",
    });

    const raw = fs.readFileSync(repo.path(), "utf8");
    expect(raw).not.toContain(secretValue);
    expect(raw).not.toContain('"apiKey"');
  });
});
