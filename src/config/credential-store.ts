/**
 * Host-separated credential storage sharing the same logical `CredentialRef` IDs.
 *
 * - CLI (`ChainCredentialStore`): OS keyring when available (secret passed over stdin
 *   with allow-listed arguments and no shell — never argv), falling back to process
 *   environment variables when headless/unavailable. Never writes plaintext secret files.
 * - VS Code extension (`VsCodeSecretCredentialStore`): delegates to `context.secrets`
 *   using a structural interface so CLI bundles never import `vscode`.
 */
import { execFileSync, spawn } from "child_process";
import type { CredentialRef } from "./provider-model";

const KEYRING_SERVICE = "champ";

const LEGACY_ID_TO_ENV: Record<string, string> = {
  "champ.claude.apiKey": "ANTHROPIC_API_KEY",
  "champ.openai.apiKey": "OPENAI_API_KEY",
  "champ.gemini.apiKey": "GEMINI_API_KEY",
  "champ.ollama.apiKey": "OLLAMA_API_KEY",
  "champ.llamacpp.apiKey": "LLAMACPP_API_KEY",
  "champ.vllm.apiKey": "VLLM_API_KEY",
  "champ.openaiCompatible.apiKey": "OPENAI_COMPATIBLE_API_KEY",
};

export function fallbackEnvVarForId(id: string): string {
  const known = LEGACY_ID_TO_ENV[id];
  if (known) return known;
  const sanitized = id
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `CHAMP_SECRET_${sanitized}`;
}

export interface CredentialStore {
  get(ref: CredentialRef): Promise<string | undefined>;
  set(ref: CredentialRef, secret: string): Promise<void>;
  delete(ref: CredentialRef): Promise<void>;
  /** Human-readable reason a key could not be stored persistently, or undefined. */
  unavailableReason?(): string | undefined;
}

export interface KeyringBackend {
  isAvailable(): boolean;
  unavailableReason(): string | undefined;
  get(id: string): Promise<string | undefined>;
  set(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Narrow structural interface matching `vscode.SecretStorage`.
 * Keeps `src/config/credential-store.ts` free of any `vscode` runtime import.
 */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

function runCommandWithStdin(
  command: string,
  args: string[],
  stdinText?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function commandExists(command: string): boolean {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    execFileSync(probe, [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export class OsKeyringBackend implements KeyringBackend {
  private readonly platform: NodeJS.Platform;
  private readonly env: Record<string, string | undefined>;
  private cachedAvailable: boolean | undefined;
  private cachedReason: string | undefined;

  constructor(opts?: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    available?: boolean;
    reason?: string;
  }) {
    this.platform = opts?.platform ?? process.platform;
    this.env = opts?.env ?? process.env;
    if (opts?.available !== undefined) {
      this.cachedAvailable = opts.available;
      this.cachedReason = opts.available
        ? undefined
        : (opts.reason ?? "OS keyring unavailable");
    }
  }

  private detect(): void {
    if (this.cachedAvailable !== undefined) return;
    if (this.platform === "darwin") {
      if (commandExists("security")) {
        this.cachedAvailable = true;
        this.cachedReason = undefined;
      } else {
        this.cachedAvailable = false;
        this.cachedReason = "macOS `security` tool not found";
      }
      return;
    }

    if (this.platform === "linux") {
      if (!this.env.DBUS_SESSION_BUS_ADDRESS) {
        this.cachedAvailable = false;
        this.cachedReason =
          "Linux D-Bus session is unavailable; export the environment variable instead";
        return;
      }
      if (!commandExists("secret-tool")) {
        this.cachedAvailable = false;
        this.cachedReason =
          "Linux `secret-tool` is not installed; export the environment variable instead";
        return;
      }
      this.cachedAvailable = true;
      this.cachedReason = undefined;
      return;
    }

    this.cachedAvailable = false;
    this.cachedReason = `No OS keyring backend configured for platform "${this.platform}"; export the environment variable instead`;
  }

  isAvailable(): boolean {
    this.detect();
    return Boolean(this.cachedAvailable);
  }

  unavailableReason(): string | undefined {
    this.detect();
    return this.cachedReason;
  }

  async get(id: string): Promise<string | undefined> {
    if (!this.isAvailable()) return undefined;
    if (this.platform === "darwin") {
      const res = await runCommandWithStdin("security", [
        "find-generic-password",
        "-a",
        id,
        "-s",
        KEYRING_SERVICE,
        "-w",
      ]);
      if (res.code !== 0) return undefined;
      return res.stdout.replace(/\r?\n$/, "");
    }
    if (this.platform === "linux") {
      const res = await runCommandWithStdin("secret-tool", [
        "lookup",
        "service",
        KEYRING_SERVICE,
        "account",
        id,
      ]);
      if (res.code !== 0) return undefined;
      return res.stdout.replace(/\r?\n$/, "");
    }
    return undefined;
  }

  async set(id: string, secret: string): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error(this.unavailableReason() ?? "OS keyring unavailable");
    }
    if (this.platform === "darwin") {
      // Pass command via `security -i` stdin so the secret never appears in argv.
      const escapedService = JSON.stringify(KEYRING_SERVICE);
      const escapedId = JSON.stringify(id);
      const escapedSecret = JSON.stringify(secret);
      const res = await runCommandWithStdin(
        "security",
        ["-i"],
        `add-generic-password -U -a ${escapedId} -s ${escapedService} -w ${escapedSecret}\n`,
      );
      if (res.code !== 0) {
        throw new Error(
          `Failed to store key in macOS keychain: ${res.stderr.trim() || `exit ${res.code}`}`,
        );
      }
      return;
    }
    if (this.platform === "linux") {
      // `secret-tool store` reads the password from stdin when invoked without argv secret.
      const res = await runCommandWithStdin(
        "secret-tool",
        [
          "store",
          "--label",
          `Champ (${id})`,
          "service",
          KEYRING_SERVICE,
          "account",
          id,
        ],
        secret,
      );
      if (res.code !== 0) {
        throw new Error(
          `Failed to store key in Linux keyring: ${res.stderr.trim() || `exit ${res.code}`}`,
        );
      }
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.isAvailable()) return;
    if (this.platform === "darwin") {
      await runCommandWithStdin("security", [
        "delete-generic-password",
        "-a",
        id,
        "-s",
        KEYRING_SERVICE,
      ]);
      return;
    }
    if (this.platform === "linux") {
      await runCommandWithStdin("secret-tool", [
        "clear",
        "service",
        KEYRING_SERVICE,
        "account",
        id,
      ]);
    }
  }
}

export class EnvCredentialStore implements CredentialStore {
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  private envKey(ref: CredentialRef): string | undefined {
    if (!ref) return undefined;
    return ref.kind === "env" ? ref.name : fallbackEnvVarForId(ref.id);
  }

  async get(ref: CredentialRef): Promise<string | undefined> {
    const key = this.envKey(ref);
    if (!key) return undefined;
    const value = this.env[key];
    return value && value.length > 0 ? value : undefined;
  }

  async set(ref: CredentialRef, secret: string): Promise<void> {
    const key = this.envKey(ref);
    if (!key) return;
    this.env[key] = secret;
  }

  async delete(ref: CredentialRef): Promise<void> {
    const key = this.envKey(ref);
    if (!key) return;
    delete this.env[key];
  }

  unavailableReason(): string | undefined {
    return "Environment variable store is process-only and does not persist across shell restarts";
  }
}

export class ChainCredentialStore implements CredentialStore {
  private readonly keyring: KeyringBackend;
  private readonly envStore: EnvCredentialStore;

  constructor(opts?: {
    keyring?: KeyringBackend;
    env?: Record<string, string | undefined>;
  }) {
    const env = opts?.env ?? process.env;
    this.keyring = opts?.keyring ?? new OsKeyringBackend({ env });
    this.envStore = new EnvCredentialStore(env);
  }

  async get(ref: CredentialRef): Promise<string | undefined> {
    if (!ref) return undefined;
    if (ref.kind === "env") {
      return this.envStore.get(ref);
    }
    if (this.keyring.isAvailable()) {
      const fromKeyring = await this.keyring.get(ref.id);
      if (fromKeyring) return fromKeyring;
    }
    return this.envStore.get(ref);
  }

  async set(ref: CredentialRef, secret: string): Promise<void> {
    if (!ref) return;
    if (ref.kind === "env") {
      await this.envStore.set(ref, secret);
      return;
    }
    if (this.keyring.isAvailable()) {
      await this.keyring.set(ref.id, secret);
      return;
    }
    // Keep secret available in the active process environment without writing plaintext to disk.
    await this.envStore.set(ref, secret);
  }

  async delete(ref: CredentialRef): Promise<void> {
    if (!ref) return;
    if (ref.kind === "env") {
      await this.envStore.delete(ref);
      return;
    }
    if (this.keyring.isAvailable()) {
      await this.keyring.delete(ref.id);
    }
    await this.envStore.delete(ref);
  }

  unavailableReason(): string | undefined {
    return this.keyring.isAvailable()
      ? undefined
      : this.keyring.unavailableReason();
  }
}

export class VsCodeSecretCredentialStore implements CredentialStore {
  private readonly secrets: SecretStorageLike;
  private readonly envStore: EnvCredentialStore;

  constructor(
    secrets: SecretStorageLike,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.secrets = secrets;
    this.envStore = new EnvCredentialStore(env);
  }

  async get(ref: CredentialRef): Promise<string | undefined> {
    if (!ref) return undefined;
    if (ref.kind === "env") {
      return this.envStore.get(ref);
    }
    const stored = await this.secrets.get(ref.id);
    if (stored) return stored;
    return this.envStore.get(ref);
  }

  async set(ref: CredentialRef, secret: string): Promise<void> {
    if (!ref) return;
    if (ref.kind === "env") {
      await this.envStore.set(ref, secret);
      return;
    }
    await this.secrets.store(ref.id, secret);
  }

  async delete(ref: CredentialRef): Promise<void> {
    if (!ref) return;
    if (ref.kind === "env") {
      await this.envStore.delete(ref);
      return;
    }
    await this.secrets.delete(ref.id);
  }

  unavailableReason(): string | undefined {
    return undefined;
  }
}
