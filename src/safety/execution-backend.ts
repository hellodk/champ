/**
 * ExecutionBackend: explicit process execution with honest isolation reporting.
 *
 * Child processes never inherit the ambient environment. Every request declares
 * its filesystem scope, network policy and resource limits before spawn. The
 * local backend is deliberately labelled as *not* isolated; the bubblewrap
 * backend is only labelled isolated after its binary and version have been
 * probed successfully. `createExecutionBackend` fails closed when OS isolation
 * is required but unavailable.
 */
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "child_process";
import * as fs from "fs";
import * as path from "path";

export type IsolationLevel = "none" | "process-group" | "os";

export interface ExecutionIsolation {
  level: IsolationLevel;
  mechanism?: string;
  /** True only when the platform mechanism was successfully probed. */
  verified: boolean;
  /** Honest report of whether memory/CPU/file-size limits can be enforced. */
  resourceLimits: "enforced" | "none";
  reason?: string;
}

export interface ExecutionLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  memoryMb?: number;
  cpuSeconds?: number;
  fileSizeMb?: number;
}

export interface ExecutionRequest {
  /** Raw shell command. Requires `shell`; is not parsed by this module. */
  command?: string;
  shell?: "bash" | "sh";
  /** Preferred, shell-free argv form. */
  argv?: string[];
  cwd: string;
  /** Absolute paths the child may write to. */
  allowedPaths: string[];
  allowNetwork: boolean;
  /** Exact environment variable names that may be copied from the base env. */
  envAllowlist: string[];
  /** Explicit environment additions (still name-validated). */
  env?: Record<string, string>;
  limits: ExecutionLimits;
  abortSignal?: AbortSignal;
  /** Optional streaming sink; never receives the full environment. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  /** Combined stdout + stderr, for tool result rendering. */
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  isolation: ExecutionIsolation;
}

export interface ExecutionBackend {
  readonly name: string;
  readonly isolation: ExecutionIsolation;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables that can redirect code loading even without shell access. */
const FORBIDDEN_ENV = new Set([
  "BASH_ENV",
  "CDPATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "GCONV_PATH",
  "IFS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PERL5LIB",
  "PS4",
  "PYTHONPATH",
  "SHELLOPTS",
]);

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type CommandExistsFn = (command: string) => boolean;

function commandAvailable(
  commandExists: CommandExistsFn | undefined,
  name: string,
): boolean {
  if (commandExists) return commandExists(name);
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resourcesRequested(limits: ExecutionLimits): boolean {
  return (
    limits.memoryMb !== undefined ||
    limits.cpuSeconds !== undefined ||
    limits.fileSizeMb !== undefined
  );
}

function prlimitArgs(limits: ExecutionLimits): string[] {
  const args: string[] = [];
  if (limits.memoryMb !== undefined)
    args.push(`--as=${Math.floor(limits.memoryMb * 1024 * 1024)}`);
  if (limits.cpuSeconds !== undefined)
    args.push(`--cpu=${Math.floor(limits.cpuSeconds)}`);
  if (limits.fileSizeMb !== undefined)
    args.push(`--fsize=${Math.floor((limits.fileSizeMb * 1024 * 1024) / 512)}`);
  return args;
}

/**
 * Wrap a command in `prlimit` when memory/CPU/file-size caps are requested.
 * A requested limit that cannot be enforced is an error, never a silent pass.
 */
function withResourceLimits(
  command: string,
  args: string[],
  request: ExecutionRequest,
  platform: NodeJS.Platform,
  commandExists?: CommandExistsFn,
): { command: string; args: string[] } | string {
  if (!resourcesRequested(request.limits)) return { command, args };
  if (platform !== "linux") {
    return `resource limits (memory/CPU/file size) are not enforced on ${platform}`;
  }
  if (!commandAvailable(commandExists, "prlimit")) {
    return "resource limits requested but prlimit is unavailable";
  }
  return {
    command: "prlimit",
    args: [...prlimitArgs(request.limits), "--", command, ...args],
  };
}

function failure(
  message: string,
  isolation: ExecutionIsolation,
): ExecutionResult {
  return {
    stdout: "",
    stderr: message,
    output: message,
    exitCode: -1,
    signal: null,
    timedOut: false,
    truncated: false,
    isolation,
  };
}

function validateRequest(request: ExecutionRequest): string | null {
  if (!request.command && (!request.argv || request.argv.length === 0)) {
    return "execution request has no command or argv";
  }
  if (request.command && !["bash", "sh"].includes(request.shell ?? "bash")) {
    return "unsupported shell";
  }
  if (!request.cwd || !path.isAbsolute(request.cwd)) {
    return "cwd must be an absolute path";
  }
  if (!fs.existsSync(request.cwd) || !fs.statSync(request.cwd).isDirectory()) {
    return "cwd does not exist or is not a directory";
  }
  if (
    !Array.isArray(request.allowedPaths) ||
    request.allowedPaths.length === 0
  ) {
    return "allowedPaths must contain at least one absolute path";
  }
  const scope = request.allowedPaths.map((p) => {
    if (!p || !path.isAbsolute(p))
      throw new Error("allowedPaths must be absolute");
    return fs.realpathSync(p);
  });
  const cwd = fs.realpathSync(request.cwd);
  if (!scope.some((p) => cwd === p || cwd.startsWith(`${p}${path.sep}`))) {
    return "cwd is outside the allowed filesystem scope";
  }
  for (const name of [
    ...request.envAllowlist,
    ...Object.keys(request.env ?? {}),
  ]) {
    if (!ENV_NAME.test(name) || FORBIDDEN_ENV.has(name)) {
      return `disallowed environment variable name: ${name}`;
    }
  }
  const limits = request.limits;
  if (
    !limits ||
    !Number.isFinite(limits.timeoutMs) ||
    limits.timeoutMs <= 0 ||
    limits.timeoutMs > MAX_TIMEOUT_MS
  ) {
    return "invalid timeout limit";
  }
  if (
    !Number.isFinite(limits.maxOutputBytes) ||
    limits.maxOutputBytes <= 0 ||
    limits.maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    return "invalid output limit";
  }
  for (const [name, value, max] of [
    ["memory limit", limits.memoryMb, 64 * 1024],
    ["CPU limit", limits.cpuSeconds, MAX_TIMEOUT_MS / 1000],
    ["file-size limit", limits.fileSizeMb, 100 * 1024],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0 || value > max) {
      return `invalid ${name}`;
    }
  }
  return null;
}

function buildEnv(
  request: ExecutionRequest,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of request.envAllowlist) {
    const value = baseEnv[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(request.env ?? {})) {
    env[name] = value;
  }
  return env;
}

function argvFor(request: ExecutionRequest): string[] {
  if (request.argv?.length) return [...request.argv];
  return [request.shell === "sh" ? "sh" : "bash", "-c", request.command!];
}

function killTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
    return;
  }
  // The child is spawned detached on POSIX so it owns a process group.
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function runChild(
  child: ChildProcess,
  request: ExecutionRequest,
  isolation: ExecutionIsolation,
  platform: NodeJS.Platform,
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const cap = request.limits.maxOutputBytes;

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(abortEscalation);
      request.abortSignal?.removeEventListener("abort", abortHandler);
      const output = `${stdout}${stderr}`;
      resolve({
        stdout,
        stderr,
        output,
        exitCode,
        signal,
        timedOut,
        truncated,
        isolation,
      });
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killTree(child, platform, "SIGKILL");
    }, request.limits.timeoutMs);

    let abortEscalation: ReturnType<typeof setTimeout> | undefined;
    const abortHandler = (): void => {
      killTree(child, platform, "SIGTERM");
      abortEscalation = setTimeout(() => {
        killTree(child, platform, "SIGKILL");
      }, 2_000);
      abortEscalation.unref?.();
    };
    if (request.abortSignal?.aborted) abortHandler();
    else request.abortSignal?.addEventListener("abort", abortHandler);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBytes += text.length;
      if (stdout.length < cap) stdout += text.slice(0, cap - stdout.length);
      if (stdoutBytes > cap) truncated = true;
      request.onOutput?.("stdout", text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBytes += text.length;
      if (stderr.length < cap) stderr += text.slice(0, cap - stderr.length);
      if (stderrBytes > cap) truncated = true;
      request.onOutput?.("stderr", text);
    });
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      if (abortEscalation) clearTimeout(abortEscalation);
      request.abortSignal?.removeEventListener("abort", abortHandler);
      settled = true;
      resolve({
        stdout,
        stderr: err.message,
        output: err.message,
        exitCode: -1,
        signal: null,
        timedOut,
        truncated,
        isolation,
      });
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export interface LocalBackendOptions {
  platform?: NodeJS.Platform;
  baseEnv?: Record<string, string | undefined>;
  spawn?: SpawnFn;
  commandExists?: CommandExistsFn;
}

export class LocalExecutionBackend implements ExecutionBackend {
  readonly name = "local";
  readonly isolation: ExecutionIsolation;
  private readonly platform: NodeJS.Platform;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly spawnFn: SpawnFn;
  private readonly commandExists?: CommandExistsFn;

  constructor(opts: LocalBackendOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.spawnFn = opts.spawn ?? spawn;
    this.commandExists = opts.commandExists;
    this.isolation = {
      // A detached process group is not OS isolation: the child still has
      // ambient filesystem and credential access.
      level: "none",
      mechanism:
        this.platform === "win32" ? "taskkill /T" : "detached process group",
      verified: false,
      resourceLimits:
        this.platform === "linux" &&
        commandAvailable(opts.commandExists, "prlimit")
          ? "enforced"
          : "none",
      reason:
        "process-tree termination only; no filesystem, network or syscall isolation",
    };
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const invalid = validateRequest(request);
    if (invalid) return failure(invalid, this.isolation);

    const argv = argvFor(request);
    const wrapped = withResourceLimits(
      argv[0],
      argv.slice(1),
      request,
      this.platform,
      this.commandExists,
    );
    if (typeof wrapped === "string") {
      return failure(
        `cannot enforce resource limits: ${wrapped}`,
        this.isolation,
      );
    }

    const child = this.spawnFn(wrapped.command, wrapped.args, {
      cwd: request.cwd,
      env: buildEnv(request, this.baseEnv),
      detached: this.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return runChild(child, request, this.isolation, this.platform);
  }
}

export interface BubblewrapBackendOptions extends LocalBackendOptions {
  probeVersion?: () => string | null;
  /** Explicit downgrade. The returned isolation level stays "none". */
  allowFallback?: boolean;
}

export class BubblewrapExecutionBackend implements ExecutionBackend {
  readonly name = "bubblewrap";
  readonly isolation: ExecutionIsolation;
  private readonly platform: NodeJS.Platform;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly spawnFn: SpawnFn;
  private readonly allowFallback: boolean;
  private readonly commandExists?: CommandExistsFn;

  constructor(opts: BubblewrapBackendOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.spawnFn = opts.spawn ?? spawn;
    this.allowFallback = opts.allowFallback ?? false;
    this.commandExists = opts.commandExists;
    this.isolation = probeBubblewrap(this.platform, opts);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const invalid = validateRequest(request);
    if (invalid) return failure(invalid, this.isolation);
    if (this.isolation.level !== "os") {
      if (!this.allowFallback) {
        return failure(
          `OS isolation unavailable (${this.isolation.reason ?? "bubblewrap not available"})`,
          this.isolation,
        );
      }
      return new LocalExecutionBackend({
        platform: this.platform,
        baseEnv: this.baseEnv,
        spawn: this.spawnFn,
      }).execute(request);
    }

    const env = buildEnv(request, this.baseEnv);
    const args: string[] = [
      "--unshare-all",
      ...(request.allowNetwork ? ["--share-net"] : []),
      "--die-with-parent",
      "--new-session",
      "--unsetenv",
      "all",
    ];
    for (const [name, value] of Object.entries(env)) {
      args.push("--setenv", name, value);
    }
    // Read-only runtime image. Only declared workspace paths are writable.
    for (const dir of ["/usr", "/bin", "/lib", "/lib64", "/sbin"]) {
      if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
    }
    if (fs.existsSync("/etc/ssl/certs")) {
      args.push("--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs");
    }
    if (fs.existsSync("/etc/resolv.conf")) {
      args.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf");
    }
    args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
    for (const allowed of request.allowedPaths) {
      const resolved = fs.realpathSync(allowed);
      args.push("--bind", resolved, resolved);
    }
    args.push("--chdir", request.cwd, "--");
    args.push(...argvFor(request));

    const wrapped = withResourceLimits(
      "bwrap",
      args,
      request,
      this.platform,
      this.commandExists,
    );
    if (typeof wrapped === "string") {
      return failure(
        `cannot enforce resource limits: ${wrapped}`,
        this.isolation,
      );
    }

    const child = this.spawnFn(wrapped.command, wrapped.args, {
      cwd: request.cwd,
      env: {},
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return runChild(child, request, this.isolation, this.platform);
  }
}

function probeBubblewrap(
  platform: NodeJS.Platform,
  opts: BubblewrapBackendOptions,
): ExecutionIsolation {
  if (platform !== "linux") {
    return {
      level: "none",
      verified: false,
      resourceLimits: commandAvailable(opts.commandExists, "prlimit")
        ? "enforced"
        : "none",
      reason: `bubblewrap is not supported on ${platform}`,
    };
  }
  const exists = opts.commandExists
    ? opts.commandExists("bwrap")
    : (() => {
        try {
          execFileSync("which", ["bwrap"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
  if (!exists) {
    return {
      level: "none",
      verified: false,
      resourceLimits: commandAvailable(opts.commandExists, "prlimit")
        ? "enforced"
        : "none",
      reason: "bwrap binary not found",
    };
  }
  try {
    const version = opts.probeVersion
      ? opts.probeVersion()
      : execFileSync("bwrap", ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
    if (!version || !/bubblewrap/i.test(version)) {
      return {
        level: "none",
        verified: false,
        resourceLimits: commandAvailable(opts.commandExists, "prlimit")
          ? "enforced"
          : "none",
        reason: "bwrap --version probe did not identify bubblewrap",
      };
    }
  } catch (err) {
    return {
      level: "none",
      verified: false,
      resourceLimits: commandAvailable(opts.commandExists, "prlimit")
        ? "enforced"
        : "none",
      reason: `bwrap version probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    level: "os",
    mechanism: "bubblewrap --unshare-all",
    verified: true,
    resourceLimits: commandAvailable(opts.commandExists, "prlimit")
      ? "enforced"
      : "none",
  };
}

export interface ExecutionBackendOptions extends BubblewrapBackendOptions {
  requireIsolation?: "none" | "os";
}

export function createExecutionBackend(
  opts: ExecutionBackendOptions = {},
): ExecutionBackend {
  const isolated = new BubblewrapExecutionBackend(opts);
  if (opts.requireIsolation === "os") {
    if (isolated.isolation.level !== "os") {
      throw new Error(
        `OS isolation required but unavailable: ${isolated.isolation.reason ?? "unknown reason"}`,
      );
    }
    return isolated;
  }
  if (isolated.isolation.level === "os") return isolated;
  return new LocalExecutionBackend(opts);
}
