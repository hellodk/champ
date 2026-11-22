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

export interface CredentialWriteStatus {
  persisted: boolean;
  storage: "keyring" | "secret-storage" | "env";
  envVar?: string;
  reason?: string;
}

export interface CredentialStore {
  get(ref: CredentialRef): Promise<string | undefined>;
  set(ref: CredentialRef, secret: string): Promise<void>;
  delete(ref: CredentialRef): Promise<void>;
  /** Human-readable reason a key could not be stored persistently, or undefined. */
  unavailableReason?(): string | undefined;
  /** Write a secret and report whether it was persisted across restarts. */
  setWithStatus?(
    ref: CredentialRef,
    secret: string,
  ): Promise<CredentialWriteStatus>;
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

export type CommandRunner = (
  command: string,
  args: string[],
  stdinText?: string,
  extraEnv?: Record<string, string | undefined>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

function runCommandWithStdin(
  command: string,
  args: string[],
  stdinText?: string,
  extraEnv?: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
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

const WIN32_CRED_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ChampWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWriteW([In] ref CREDENTIAL userCredential, [In] uint flags);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredReadW(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);

  [DllImport("advapi32.dll", SetLastError = false)]
  public static extern void CredFree([In] IntPtr cred);

  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL cred = new CREDENTIAL();
      cred.Type = 1; // CRED_TYPE_GENERIC
      cred.TargetName = target;
      cred.CredentialBlobSize = (uint)bytes.Length;
      cred.CredentialBlob = blob;
      cred.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE
      cred.UserName = "champ";
      if (!CredWriteW(ref cred, 0)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(blob);
    }
  }

  public static string Read(string target) {
    IntPtr credPtr;
    if (!CredReadW(target, 1, 0, out credPtr)) return null;
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
      if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
      return Encoding.Unicode.GetString(bytes);
    } finally {
      CredFree(credPtr);
    }
  }

  public static void Delete(string target) {
    CredDeleteW(target, 1, 0);
  }
}
`;

function win32Script(action: "get" | "set" | "delete"): string {
  const targetExpr = "$env:CHAMP_CRED_TARGET";
  const body =
    action === "set"
      ? `$secret = [Console]::In.ReadToEnd(); [ChampWinCred]::Write(${targetExpr}, $secret)`
      : action === "get"
        ? `$val = [ChampWinCred]::Read(${targetExpr}); if ($null -ne $val) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($val))) }`
        : `[ChampWinCred]::Delete(${targetExpr})`;
  return `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WIN32_CRED_CSHARP}\n'@; ${body}`;
}

export class OsKeyringBackend implements KeyringBackend {
  private readonly platform: NodeJS.Platform;
  private readonly env: Record<string, string | undefined>;
  private readonly probeCommand: (command: string) => boolean;
  private readonly runCmd: CommandRunner;
  private winShell: string = "powershell.exe";
  private cachedAvailable: boolean | undefined;
  private cachedReason: string | undefined;

  constructor(opts?: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    available?: boolean;
    reason?: string;
    commandExists?: (command: string) => boolean;
    runCommand?: CommandRunner;
  }) {
    this.platform = opts?.platform ?? process.platform;
    this.env = opts?.env ?? process.env;
    this.probeCommand = opts?.commandExists ?? commandExists;
    this.runCmd = opts?.runCommand ?? runCommandWithStdin;
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
      if (this.probeCommand("security")) {
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
          "Linux D-Bus session is unavailable; use an explicit environment-variable reference instead";
        return;
      }
      if (!this.probeCommand("secret-tool")) {
        this.cachedAvailable = false;
        this.cachedReason =
          "Linux `secret-tool` is not installed; install libsecret-tools or use an explicit environment-variable reference";
        return;
      }
      this.cachedAvailable = true;
      this.cachedReason = undefined;
      return;
    }

    if (this.platform === "win32") {
      const shell = this.probeCommand("powershell.exe")
        ? "powershell.exe"
        : this.probeCommand("powershell")
          ? "powershell"
          : this.probeCommand("pwsh")
            ? "pwsh"
            : null;
      if (shell) {
        this.winShell = shell;
        this.cachedAvailable = true;
        this.cachedReason = undefined;
      } else {
        this.cachedAvailable = false;
        this.cachedReason =
          "Windows PowerShell not found for Credential Manager; export the environment variable instead";
      }
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
      const res = await this.runCmd("security", [
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
      const res = await this.runCmd("secret-tool", [
        "lookup",
        "service",
        KEYRING_SERVICE,
        "account",
        id,
      ]);
      if (res.code !== 0) return undefined;
      return res.stdout.replace(/\r?\n$/, "");
    }
    if (this.platform === "win32") {
      const res = await this.runCmd(
        this.winShell,
        ["-NoProfile", "-NonInteractive", "-Command", win32Script("get")],
        undefined,
        { CHAMP_CRED_TARGET: `${KEYRING_SERVICE}:${id}` },
      );
      if (res.code !== 0 || !res.stdout) return undefined;
      try {
        return Buffer.from(res.stdout.trim(), "base64").toString("utf8");
      } catch {
        return undefined;
      }
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
      const res = await this.runCmd(
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
      const res = await this.runCmd(
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
      return;
    }
    if (this.platform === "win32") {
      const res = await this.runCmd(
        this.winShell,
        ["-NoProfile", "-NonInteractive", "-Command", win32Script("set")],
        secret,
        { CHAMP_CRED_TARGET: `${KEYRING_SERVICE}:${id}` },
      );
      if (res.code !== 0) {
        throw new Error(
          `Failed to store key in Windows Credential Manager: ${res.stderr.trim() || `exit ${res.code}`}`,
        );
      }
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.isAvailable()) return;
    if (this.platform === "darwin") {
      await this.runCmd("security", [
        "delete-generic-password",
        "-a",
        id,
        "-s",
        KEYRING_SERVICE,
      ]);
      return;
    }
    if (this.platform === "linux") {
      await this.runCmd("secret-tool", [
        "clear",
        "service",
        KEYRING_SERVICE,
        "account",
        id,
      ]);
      return;
    }
    if (this.platform === "win32") {
      await this.runCmd(
        this.winShell,
        ["-NoProfile", "-NonInteractive", "-Command", win32Script("delete")],
        undefined,
        { CHAMP_CRED_TARGET: `${KEYRING_SERVICE}:${id}` },
      );
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
    await this.setWithStatus(ref, secret);
  }

  async setWithStatus(
    ref: CredentialRef,
    secret: string,
  ): Promise<CredentialWriteStatus> {
    const key = this.envKey(ref);
    if (key) {
      this.env[key] = secret;
    }
    return {
      persisted: false,
      storage: "env",
      envVar: key,
      reason: this.unavailableReason(),
    };
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
    await this.setWithStatus(ref, secret);
  }

  async setWithStatus(
    ref: CredentialRef,
    secret: string,
  ): Promise<CredentialWriteStatus> {
    if (!ref) {
      return {
        persisted: false,
        storage: "env",
        reason: "No credential reference configured",
      };
    }
    if (ref.kind === "env") {
      return this.envStore.setWithStatus(ref, secret);
    }
    if (this.keyring.isAvailable()) {
      await this.keyring.set(ref.id, secret);
      return { persisted: true, storage: "keyring" };
    }
    // Keep secret available in the active process environment without writing plaintext to disk.
    await this.envStore.set(ref, secret);
    return {
      persisted: false,
      storage: "env",
      envVar: fallbackEnvVarForId(ref.id),
      reason: this.keyring.unavailableReason(),
    };
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
    await this.setWithStatus(ref, secret);
  }

  async setWithStatus(
    ref: CredentialRef,
    secret: string,
  ): Promise<CredentialWriteStatus> {
    if (!ref) {
      return {
        persisted: false,
        storage: "secret-storage",
        reason: "No credential reference configured",
      };
    }
    if (ref.kind === "env") {
      return this.envStore.setWithStatus(ref, secret);
    }
    await this.secrets.store(ref.id, secret);
    return { persisted: true, storage: "secret-storage" };
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

/**
 * Unified credential store for VS Code extension host: shares the OS keyring
 * with the CLI (`ChainCredentialStore`) when available and retains VS Code
 * `SecretStorage` as fallback/legacy migration storage.
 */
export class SharedCredentialStore implements CredentialStore {
  private readonly keyring: KeyringBackend;
  private readonly secrets: SecretStorageLike;
  private readonly envStore: EnvCredentialStore;

  constructor(
    secrets: SecretStorageLike,
    opts?: {
      keyring?: KeyringBackend;
      env?: Record<string, string | undefined>;
    },
  ) {
    const env = opts?.env ?? process.env;
    this.keyring = opts?.keyring ?? new OsKeyringBackend({ env });
    this.secrets = secrets;
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
    const fromVsCode = await this.secrets.get(ref.id);
    if (fromVsCode) return fromVsCode;
    return this.envStore.get(ref);
  }

  async set(ref: CredentialRef, secret: string): Promise<void> {
    await this.setWithStatus(ref, secret);
  }

  async setWithStatus(
    ref: CredentialRef,
    secret: string,
  ): Promise<CredentialWriteStatus> {
    if (!ref) {
      return {
        persisted: false,
        storage: "secret-storage",
        reason: "No credential reference configured",
      };
    }
    if (ref.kind === "env") {
      return this.envStore.setWithStatus(ref, secret);
    }
    if (this.keyring.isAvailable()) {
      await this.keyring.set(ref.id, secret);
      return { persisted: true, storage: "keyring" };
    }
    await this.secrets.store(ref.id, secret);
    return { persisted: true, storage: "secret-storage" };
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
    await this.secrets.delete(ref.id);
    await this.envStore.delete(ref);
  }

  unavailableReason(): string | undefined {
    return undefined;
  }
}
