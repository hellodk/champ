import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ChainCredentialStore,
  EnvCredentialStore,
  OsKeyringBackend,
  SharedCredentialStore,
  VsCodeSecretCredentialStore,
  type KeyringBackend,
  type SecretStorageLike,
} from "@/config/credential-store";
import { EndpointRepository } from "@/config/provider-repository";

function makeMockBackend(available: boolean): KeyringBackend & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    isAvailable: () => available,
    unavailableReason: () =>
      available ? undefined : "OS keyring is unavailable in this environment",
    get: async (id) => store.get(id),
    set: async (id, secret) => {
      store.set(id, secret);
    },
    delete: async (id) => {
      store.delete(id);
    },
  };
}

describe("CredentialStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("EnvCredentialStore reads env refs and returns undefined when unset", async () => {
    const env: Record<string, string | undefined> = {
      MY_API_KEY: "env-secret-123",
    };
    const store = new EnvCredentialStore(env);

    expect(await store.get({ kind: "env", name: "MY_API_KEY" })).toBe(
      "env-secret-123",
    );
    expect(
      await store.get({ kind: "env", name: "MISSING_KEY" }),
    ).toBeUndefined();
    expect(await store.get(null)).toBeUndefined();
  });

  it("ChainCredentialStore delegates keyring refs to an injected keyring backend", async () => {
    const backend = makeMockBackend(true);
    const store = new ChainCredentialStore({ keyring: backend, env: {} });
    const ref = { kind: "keyring" as const, id: "ep_local01" };

    expect(store.unavailableReason()).toBeUndefined();
    await store.set(ref, "super-secret-token");
    expect(backend.store.get("ep_local01")).toBe("super-secret-token");
    expect(await store.get(ref)).toBe("super-secret-token");

    await store.delete(ref);
    expect(await store.get(ref)).toBeUndefined();
  });

  it("ChainCredentialStore falls back from an unavailable keyring to env", async () => {
    const backend = makeMockBackend(false);
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "sk-from-env",
      MY_CUSTOM_TOKEN: "tok-custom",
    };
    const store = new ChainCredentialStore({ keyring: backend, env });

    expect(store.unavailableReason()).toContain("unavailable");
    expect(
      await store.get({ kind: "keyring", id: "champ.openai.apiKey" }),
    ).toBe("sk-from-env");
    expect(await store.get({ kind: "env", name: "MY_CUSTOM_TOKEN" })).toBe(
      "tok-custom",
    );

    // Setting while keyring is unavailable keeps the key in process env for the
    // current run rather than writing any plaintext file.
    await store.set({ kind: "keyring", id: "ep_temp" }, "in-memory-secret");
    expect(await store.get({ kind: "keyring", id: "ep_temp" })).toBe(
      "in-memory-secret",
    );
  });

  it("VsCodeSecretCredentialStore uses the exact ref id as the SecretStorage key", async () => {
    const backing = new Map<string, string>();
    const secretStorage: SecretStorageLike = {
      get: vi.fn(async (key: string) => backing.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        backing.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        backing.delete(key);
      }),
    };
    const store = new VsCodeSecretCredentialStore(secretStorage, {
      FALLBACK_ENV: "env-val",
    });
    const ref = { kind: "keyring" as const, id: "champ.claude.apiKey" };

    await store.set(ref, "sk-ant-123");
    expect(secretStorage.store).toHaveBeenCalledWith(
      "champ.claude.apiKey",
      "sk-ant-123",
    );
    expect(await store.get(ref)).toBe("sk-ant-123");
    expect(secretStorage.get).toHaveBeenCalledWith("champ.claude.apiKey");

    expect(await store.get({ kind: "env", name: "FALLBACK_ENV" })).toBe(
      "env-val",
    );

    await store.delete(ref);
    expect(secretStorage.delete).toHaveBeenCalledWith("champ.claude.apiKey");
    expect(await store.get(ref)).toBeUndefined();
  });

  it("never writes a secret into the repository document", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-cred-repo-"));
    dirs.push(home);
    const repo = new EndpointRepository({ homeDir: home });
    const backend = makeMockBackend(true);
    const store = new ChainCredentialStore({ keyring: backend, env: {} });
    const secret = "sk-live-secret-999999";

    const ref = { kind: "keyring" as const, id: "ep_abc12345" };
    await store.set(ref, secret);
    await repo.write({
      version: 1,
      endpoints: [
        {
          id: "ep_abc12345",
          name: "Protected vLLM",
          provider: "vllm",
          baseUrl: "http://localhost:8000/v1",
          credential: ref,
          enabled: true,
          isDefault: true,
          models: [],
        },
      ],
      assignments: {},
      routingMode: "auto",
    });

    const jsonText = fs.readFileSync(repo.path(), "utf8");
    expect(jsonText).not.toContain(secret);
    expect(await store.get(ref)).toBe(secret);
  });

  it("SharedCredentialStore reads CLI keyring secrets and falls back to VS Code SecretStorage", async () => {
    const keyring = makeMockBackend(true);
    const backing = new Map<string, string>([
      ["champ.claude.apiKey", "legacy-vscode-secret"],
    ]);
    const secretStorage: SecretStorageLike = {
      get: async (key) => backing.get(key),
      store: async (key, val) => {
        backing.set(key, val);
      },
      delete: async (key) => {
        backing.delete(key);
      },
    };
    const shared = new SharedCredentialStore(secretStorage, {
      keyring,
      env: {},
    });

    // CLI writes ep_cli01 to OS keyring; VS Code SharedCredentialStore sees it.
    const cli = new ChainCredentialStore({ keyring, env: {} });
    await cli.set({ kind: "keyring", id: "ep_cli01" }, "cli-shared-token");
    expect(await shared.get({ kind: "keyring", id: "ep_cli01" })).toBe(
      "cli-shared-token",
    );

    // VS Code writes ep_ext02 via SharedCredentialStore; CLI reads it.
    const status = await shared.setWithStatus(
      { kind: "keyring", id: "ep_ext02" },
      "ext-shared-token",
    );
    expect(status).toEqual({ persisted: true, storage: "keyring" });
    expect(await cli.get({ kind: "keyring", id: "ep_ext02" })).toBe(
      "ext-shared-token",
    );

    // Legacy VS Code SecretStorage key still readable as fallback.
    expect(
      await shared.get({ kind: "keyring", id: "champ.claude.apiKey" }),
    ).toBe("legacy-vscode-secret");

    await shared.delete({ kind: "keyring", id: "champ.claude.apiKey" });
    expect(backing.has("champ.claude.apiKey")).toBe(false);
  });

  it("OsKeyringBackend supports win32 Credential Manager via PowerShell stdin without exposing secrets in argv", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      stdinText?: string;
      extraEnv?: Record<string, string | undefined>;
    }> = [];
    const store = new Map<string, string>();
    const backend = new OsKeyringBackend({
      platform: "win32",
      env: {},
      commandExists: (cmd) => cmd === "powershell.exe",
      runCommand: async (command, args, stdinText, extraEnv) => {
        calls.push({ command, args, stdinText, extraEnv });
        const target = extraEnv?.CHAMP_CRED_TARGET ?? "";
        if (stdinText !== undefined) {
          store.set(target, stdinText);
          return { code: 0, stdout: "", stderr: "" };
        }
        const script = args[args.length - 1] ?? "";
        if (script.includes("[ChampWinCred]::Read(")) {
          const val = store.get(target);
          return val !== undefined
            ? {
                code: 0,
                stdout: Buffer.from(val, "utf8").toString("base64"),
                stderr: "",
              }
            : { code: 0, stdout: "", stderr: "" };
        }
        if (script.includes("[ChampWinCred]::Delete(")) {
          store.delete(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected script" };
      },
    });

    expect(backend.isAvailable()).toBe(true);
    expect(backend.unavailableReason()).toBeUndefined();

    await backend.set("ep_win01", "win-secret-token");
    expect(calls[0].args.join(" ")).not.toContain("win-secret-token");
    expect(calls[0].stdinText).toBe("win-secret-token");
    expect(await backend.get("ep_win01")).toBe("win-secret-token");

    await backend.delete("ep_win01");
    expect(await backend.get("ep_win01")).toBeUndefined();
  });

  it("ChainCredentialStore.setWithStatus reports non-persistent env storage when keyring is unavailable", async () => {
    const backend = makeMockBackend(false);
    const env: Record<string, string | undefined> = {};
    const store = new ChainCredentialStore({ keyring: backend, env });
    const status = await store.setWithStatus(
      { kind: "keyring", id: "ep_headless" },
      "temp-secret",
    );
    expect(status.persisted).toBe(false);
    expect(status.storage).toBe("env");
    expect(status.envVar).toBe("CHAMP_SECRET_EP_HEADLESS");
    expect(status.reason).toContain("unavailable");
  });
});
