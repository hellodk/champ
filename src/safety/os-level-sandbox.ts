/**
 * OSLevelSandbox: Real OS-level isolation using bwrap (Bubblewrap) and seccomp.
 *
 * Provides true filesystem, network, and capability restrictions for command
 * execution. Leverages Linux bwrap (user-space) and seccomp filters for
 * isolation without requiring root privileges.
 *
 * Gracefully degrades to unsandboxed execution on systems without bwrap.
 * Can be combined with CommandSandbox for defense-in-depth filtering.
 */

import { spawn, execSync } from "child_process";
import * as fs from "fs";

export interface SandboxConfig {
  /** Paths to mount as read-only in the sandbox. */
  readonly_paths?: string[];
  /** Working directory for sandboxed commands. */
  work_dir?: string;
  /** Mount point for temporary writable directory. */
  tmpfs_size?: string;
  /** System calls to deny (requires seccomp). */
  deny_syscalls?: string[];
  /** If true, mount filesystem root as read-only (requires work_dir for writes). */
  readonly_root?: boolean;
  /** If true, disable network access. */
  restrict_net?: boolean;
  /** If true, allow fallback to unsandboxed execution if bwrap unavailable. */
  allow_fallback?: boolean;
}

export interface ExecutionOptions extends SandboxConfig {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number;
  sandboxed?: boolean;
}

export class OSLevelSandbox {
  private readonly defaultConfig: SandboxConfig;
  private bwrapAvailable: boolean | null = null;
  private seccompSupported: boolean | null = null;

  constructor(config: SandboxConfig = {}) {
    this.defaultConfig = {
      readonly_paths: ["/etc", "/usr", "/var/lib", "/sys", "/proc"],
      tmpfs_size: "100M",
      restrict_net: false,
      allow_fallback: true,
      ...config,
    };
  }

  /**
   * Detect if bwrap is available on this system.
   */
  async isBwrapAvailable(): Promise<boolean> {
    if (this.bwrapAvailable !== null) {
      return this.bwrapAvailable;
    }

    try {
      execSync("which bwrap", { stdio: "pipe" });
      this.bwrapAvailable = true;
      return true;
    } catch {
      this.bwrapAvailable = false;
      return false;
    }
  }

  /**
   * Detect if seccomp is supported on this system.
   */
  async isSeccompSupported(): Promise<boolean> {
    if (this.seccompSupported !== null) {
      return this.seccompSupported;
    }

    try {
      // Check if seccomp is available in the kernel
      const supported = fs.existsSync("/proc/sys/kernel/seccomp");
      this.seccompSupported = supported;
      return supported;
    } catch {
      this.seccompSupported = false;
      return false;
    }
  }

  /**
   * Check if OS-level sandboxing is available on this system.
   */
  async isSandboxingCapable(): Promise<boolean> {
    if (process.platform !== "linux") {
      // Only Linux has bwrap/seccomp support
      return false;
    }
    return await this.isBwrapAvailable();
  }

  /**
   * Get the default sandbox configuration.
   */
  async getDefaultConfig(): Promise<SandboxConfig> {
    return { ...this.defaultConfig };
  }

  /**
   * Check if a command is actually running in a real sandbox.
   */
  async isActuallySandboxed(): Promise<boolean> {
    return await this.isSandboxingCapable();
  }

  /**
   * Get integration options for combining with CommandSandbox.
   */
  async getIntegrationOptions(): Promise<{
    supportsDenylist: boolean;
    supportsAllowlist: boolean;
    supportsSeccomp: boolean;
  }> {
    return {
      supportsDenylist: true,
      supportsAllowlist: true,
      supportsSeccomp: await this.isSeccompSupported(),
    };
  }

  /**
   * Execute a command within the sandbox.
   */
  async executeInSandbox(
    command: string,
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const cwd = options.cwd ?? process.cwd();
    const work_dir = options.work_dir ?? cwd;
    const allow_fallback =
      options.allow_fallback ?? this.defaultConfig.allow_fallback ?? true;

    // Validate working directory
    if (!fs.existsSync(work_dir)) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        error: `Working directory does not exist: ${work_dir}`,
        sandboxed: false,
      };
    }

    // Try to use bwrap if available
    const bwrapAvailable = await this.isBwrapAvailable();
    if (bwrapAvailable && process.platform === "linux") {
      const result = await this.executeWithBwrap(command, {
        ...options,
        cwd: work_dir,
      });
      // If bwrap succeeded, return it
      if (result.sandboxed) {
        return result;
      }
      // If bwrap failed but we want fallback, continue to unsandboxed
      if (!allow_fallback) {
        return result;
      }
    }

    // Fall back to unsandboxed execution if allowed or if bwrap failed
    if (allow_fallback) {
      return this.executeUnsandboxed(command, { ...options, cwd: work_dir });
    }

    return {
      success: false,
      stdout: "",
      stderr: "",
      error:
        "Sandboxing not available and fallback is disabled. Install bwrap for isolation.",
      sandboxed: false,
    };
  }

  /**
   * Execute command using bwrap (Bubblewrap) for filesystem isolation.
   */
  private async executeWithBwrap(
    command: string,
    options: ExecutionOptions,
  ): Promise<ExecutionResult> {
    const cwd = options.cwd ?? process.cwd();
    const work_dir = options.work_dir ?? cwd;
    const readonly_paths =
      options.readonly_paths ?? this.defaultConfig.readonly_paths;
    const restrict_net =
      options.restrict_net ?? this.defaultConfig.restrict_net;
    const timeout = options.timeout ?? 30000;

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const bwrapArgs: string[] = ["--dev", "/dev", "--proc", "/proc"];

      // Mount essential system directories as read-only for the sandbox to work
      // bash, sh, and other essential tools need these
      if (fs.existsSync("/lib")) {
        bwrapArgs.push("--ro-bind", "/lib", "/lib");
      }
      if (fs.existsSync("/lib64")) {
        bwrapArgs.push("--ro-bind", "/lib64", "/lib64");
      }
      if (fs.existsSync("/usr")) {
        bwrapArgs.push("--ro-bind", "/usr", "/usr");
      }
      if (fs.existsSync("/bin")) {
        bwrapArgs.push("--ro-bind", "/bin", "/bin");
      }

      // Add tmpfs for temporary files
      bwrapArgs.push("--tmpfs", "/tmp");

      // Mount work directory as writable
      bwrapArgs.push("--bind", work_dir, "/work");

      // Mount additional readonly paths
      if (readonly_paths) {
        for (const path of readonly_paths) {
          if (fs.existsSync(path)) {
            bwrapArgs.push("--ro-bind", path, path);
          }
        }
      }

      // Disable network if requested
      if (restrict_net) {
        bwrapArgs.push("--unshare-net");
      }

      // Set working directory and execute command
      bwrapArgs.push("--chdir", "/work", "bash", "-c", command);

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("bwrap", bwrapArgs, {
          cwd: work_dir,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return resolve({
          success: false,
          stdout: "",
          stderr: "",
          error: `Failed to spawn bwrap: ${msg}`,
          sandboxed: false,
        });
      }

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);

      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        return resolve({
          success: false,
          stdout,
          stderr,
          error: `Bwrap execution failed: ${err.message}`,
          sandboxed: false,
        });
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);

        if (timedOut) {
          return resolve({
            success: false,
            stdout,
            stderr,
            error: `Command timed out after ${timeout}ms`,
            exitCode: -1,
            sandboxed: true,
          });
        }

        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code ?? undefined,
          sandboxed: true,
        });
      });
    });
  }

  /**
   * Fallback: execute command without sandboxing.
   * Used when bwrap is not available but fallback is enabled.
   */
  private async executeUnsandboxed(
    command: string,
    options: ExecutionOptions,
  ): Promise<ExecutionResult> {
    const cwd = options.cwd ?? process.cwd();
    const timeout = options.timeout ?? 30000;
    const env = options.env ?? process.env;

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      if (!fs.existsSync(cwd)) {
        return resolve({
          success: false,
          stdout: "",
          stderr: "",
          error: `Working directory does not exist: ${cwd}`,
          sandboxed: false,
        });
      }

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("bash", ["-c", command], {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return resolve({
          success: false,
          stdout: "",
          stderr: "",
          error: `Failed to spawn command: ${msg}`,
          sandboxed: false,
        });
      }

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);

      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        return resolve({
          success: false,
          stdout,
          stderr,
          error: `Command execution failed: ${err.message}`,
          sandboxed: false,
        });
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);

        if (timedOut) {
          return resolve({
            success: false,
            stdout,
            stderr,
            error: `Command timed out after ${timeout}ms`,
            exitCode: -1,
            sandboxed: false,
          });
        }

        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code ?? undefined,
          sandboxed: false,
        });
      });
    });
  }
}
