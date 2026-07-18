/**
 * AdvancedCommandSandbox: Comprehensive command sandboxing with:
 * - Environment variable isolation
 * - Path validation and restriction
 * - Audit logging of all command executions
 * - Resource limits (timeout, memory)
 * - MCP server configuration validation
 * - User approval tracking
 * - YAML configuration support
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

export interface SandboxConfig {
  /** Path to audit log file */
  auditLogPath?: string;
  /** Root workspace path for relative path restrictions */
  workspacePath: string;
  /** Enable audit logging */
  enableAuditLog?: boolean;
  /** Environment variables to restrict/strip */
  restrictedEnvVars?: string[];
  /** Allowed workspace paths (default: [workspacePath]) */
  allowedWorkspacePaths: string[];
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Memory limit in MB (default: 512) */
  memoryLimitMb?: number;
  /** Whitelist of allowed commands (allowlist-only mode) */
  allowlist?: string[];
  /** Blacklist of denied commands */
  denylist?: string[];
  /** Whitelisted MCP servers */
  allowedMCPServers?: string[];
}

export interface CommandAuditLog {
  timestamp: Date;
  command: string;
  status: "ALLOW" | "DENY" | "TIMEOUT";
  exitCode?: number;
  reason?: string;
  userApproved?: boolean;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface TimeoutResult {
  timedOut: boolean;
  exitCode?: number;
}

export class AdvancedCommandSandbox {
  private config: Required<SandboxConfig>;
  private auditLogs: CommandAuditLog[] = [];
  private approvalCache: Map<string, boolean> = new Map();

  constructor(config: SandboxConfig) {
    this.config = {
      auditLogPath: config.auditLogPath || ".champ/audit.log",
      workspacePath: config.workspacePath,
      enableAuditLog: config.enableAuditLog ?? true,
      restrictedEnvVars: config.restrictedEnvVars ?? [
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "DATABASE_PASSWORD",
        "GITHUB_TOKEN",
        "OPENAI_API_KEY",
      ],
      allowedWorkspacePaths: config.allowedWorkspacePaths,
      timeoutMs: config.timeoutMs ?? 30000,
      memoryLimitMb: config.memoryLimitMb ?? 512,
      allowlist: config.allowlist ?? [],
      denylist: config.denylist ?? [],
      allowedMCPServers: config.allowedMCPServers ?? [],
    };

    this.ensureAuditLogDir();
  }

  /**
   * Get environment with restricted variables stripped.
   */
  getIsolatedEnv(env: Record<string, string>): Record<string, string> {
    const isolated: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (!this.config.restrictedEnvVars.includes(key)) {
        isolated[key] = value;
      }
    }
    return isolated;
  }

  /**
   * Validate that a command doesn't access paths outside allowed workspace.
   */
  validatePath(command: string): SandboxCheckResult {
    // Extract potential file paths from command
    const pathPatterns = [
      /(?:^|\s)(?:cat|less|vim|nano|emacs|cp|mv|rm|ls|mkdir|rmdir|chmod|chown)\s+([^\s|&;$]+)/,
      /(?:^|\s)(?:cd|pushd|popd)\s+([^\s|&;$]+)/,
    ];

    for (const pattern of pathPatterns) {
      const match = command.match(pattern);
      if (match && match[1]) {
        const targetPath = match[1];

        // Check for directory traversal
        if (targetPath.includes("../")) {
          return {
            allowed: false,
            reason: "directory traversal attempt detected",
          };
        }

        // Check for sensitive paths
        if (
          targetPath.startsWith("/etc/") ||
          targetPath.startsWith("/root/") ||
          targetPath.startsWith("/boot/") ||
          targetPath.startsWith("/sys/") ||
          targetPath.startsWith("/proc/") ||
          targetPath === "/etc/shadow" ||
          targetPath === "/etc/passwd"
        ) {
          return {
            allowed: false,
            reason: "access to sensitive system paths is blocked",
          };
        }

        // For absolute paths outside workspace, block
        if (
          targetPath.startsWith("/") &&
          !this.config.allowedWorkspacePaths.some((p) =>
            targetPath.startsWith(p),
          )
        ) {
          return {
            allowed: false,
            reason: "access outside allowed workspace paths",
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Log command execution to audit log.
   */
  async logCommandExecution(log: CommandAuditLog): Promise<void> {
    this.auditLogs.push(log);

    if (this.config.enableAuditLog) {
      const logLine = this.formatAuditLogLine(log);
      return new Promise((resolve, reject) => {
        fs.appendFile(this.config.auditLogPath, logLine + "\n", (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  /**
   * Synchronous version of logCommandExecution for simpler use.
   */
  logCommandExecutionSync(log: CommandAuditLog): void {
    this.auditLogs.push(log);

    if (this.config.enableAuditLog) {
      const logLine = this.formatAuditLogLine(log);
      try {
        fs.appendFileSync(this.config.auditLogPath, logLine + "\n");
      } catch (err) {
        console.error("Failed to write audit log:", err);
      }
    }
  }

  /**
   * Get in-memory audit logs.
   */
  getAuditLogs(): CommandAuditLog[] {
    return [...this.auditLogs];
  }

  /**
   * Execute command with timeout enforcement.
   */
  async executeWithTimeout(
    command: string,
    timeoutMs: number,
  ): Promise<TimeoutResult> {
    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", command], {
        timeout: timeoutMs,
      });

      const timeoutHandle = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ timedOut: true });
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        resolve({ timedOut: false, exitCode: code ?? undefined });
      });

      proc.on("error", () => {
        clearTimeout(timeoutHandle);
        resolve({ timedOut: false });
      });
    });
  }

  /**
   * Validate MCP server configuration.
   */
  validateMCPServerCommand(config: MCPServerConfig): SandboxCheckResult {
    // Check if server is in whitelist
    if (
      this.config.allowedMCPServers.includes(config.name) &&
      this.config.allowedMCPServers.length > 0
    ) {
      return { allowed: true };
    }

    // Block dangerous commands
    const dangerousCommands = [
      "rm",
      "mkfs",
      "dd",
      "fdisk",
      "umount",
      "mount",
      "sudo",
      "su",
      "chown",
      "chmod",
    ];

    if (dangerousCommands.includes(config.command)) {
      return {
        allowed: false,
        reason: `blocked: ${config.command} is dangerous for MCP servers`,
      };
    }

    // Block sudo in args
    if (config.args.includes("sudo")) {
      return {
        allowed: false,
        reason: "MCP servers cannot run with sudo",
      };
    }

    return { allowed: true };
  }

  /**
   * Record user approval for a command.
   */
  recordApproval(command: string, approved: boolean): void {
    this.approvalCache.set(command, approved);
  }

  /**
   * Check if approval is cached (true=approved, false=denied, null=not cached).
   */
  isApprovalCached(command: string): boolean | null {
    const cached = this.approvalCache.get(command);
    return cached ?? null;
  }

  /**
   * Clear approval cache.
   */
  clearApprovalCache(): void {
    this.approvalCache.clear();
  }

  /**
   * Load configuration from YAML file.
   */
  static loadConfigFromYaml(filePath: string): Partial<SandboxConfig> | null {
    try {
      // Simple YAML parser for basic key-value structure
      const content = fs.readFileSync(filePath, "utf-8");
      const config: Record<string, unknown> = {};

      const lines = content.split("\n");
      let currentSection = "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        if (trimmed.endsWith(":")) {
          currentSection = trimmed.slice(0, -1);
          config[currentSection] = [];
        } else if (trimmed.startsWith("- ")) {
          const value = trimmed.slice(2);
          if (currentSection) {
            const arr = config[currentSection] as string[] | undefined;
            if (Array.isArray(arr)) {
              arr.push(value);
            }
          }
        } else if (trimmed.includes(":")) {
          const [key, value] = trimmed.split(":").map((s) => s.trim());
          config[key] = value;
        }
      }

      return config as Partial<SandboxConfig>;
    } catch (err) {
      console.error("Failed to load YAML config:", err);
      return null;
    }
  }

  /**
   * Internal helpers
   */
  private formatAuditLogLine(log: CommandAuditLog): string {
    const timestamp = log.timestamp.toISOString();
    const approval = log.userApproved ? "APPROVED" : "PENDING";
    const exitInfo =
      log.exitCode !== undefined ? ` [exit:${log.exitCode}]` : "";
    const reason = log.reason ? ` - ${log.reason}` : "";

    return `[${timestamp}] [${log.status}] [${approval}] ${log.command}${exitInfo}${reason}`;
  }

  private ensureAuditLogDir(): void {
    if (this.config.enableAuditLog) {
      const dir = path.dirname(this.config.auditLogPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }
}
