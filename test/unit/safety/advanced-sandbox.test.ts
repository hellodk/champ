/**
 * TDD: Tests for Advanced Command Sandboxing features.
 * Validates environment isolation, path validation, audit logging, and resource limits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  AdvancedCommandSandbox,
  SandboxConfig,
  type CommandAuditLog,
} from "@/safety/advanced-command-sandbox";

describe("AdvancedCommandSandbox", () => {
  let sandbox: AdvancedCommandSandbox;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(process.cwd(), ".test-sandbox");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const config: SandboxConfig = {
      auditLogPath: path.join(tempDir, "audit.log"),
      workspacePath: tempDir,
      enableAuditLog: true,
      restrictedEnvVars: ["AWS_SECRET_ACCESS_KEY", "DATABASE_PASSWORD"],
      allowedWorkspacePaths: [tempDir],
      timeoutMs: 5000,
      memoryLimitMb: 512,
    };
    sandbox = new AdvancedCommandSandbox(config);
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("Environment Isolation", () => {
    it("should strip restricted environment variables", () => {
      const env = {
        PATH: "/usr/bin",
        HOME: "/home/user",
        AWS_SECRET_ACCESS_KEY: "secret-value",
        DATABASE_PASSWORD: "db-password",
        NORMAL_VAR: "normal-value",
      };

      const isolated = sandbox.getIsolatedEnv(env);

      expect(isolated.PATH).toBe("/usr/bin");
      expect(isolated.HOME).toBe("/home/user");
      expect(isolated.NORMAL_VAR).toBe("normal-value");
      expect(isolated.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(isolated.DATABASE_PASSWORD).toBeUndefined();
    });

    it("should support custom restricted environment variables", () => {
      const customConfig: SandboxConfig = {
        auditLogPath: path.join(tempDir, "audit.log"),
        workspacePath: tempDir,
        restrictedEnvVars: ["MY_SECRET"],
        allowedWorkspacePaths: [tempDir],
      };
      const custom = new AdvancedCommandSandbox(customConfig);
      const env = { MY_SECRET: "value", OTHER: "ok" };
      const isolated = custom.getIsolatedEnv(env);

      expect(isolated.MY_SECRET).toBeUndefined();
      expect(isolated.OTHER).toBe("ok");
    });
  });

  describe("Path Validation", () => {
    it("should allow commands in workspace directory", () => {
      const check = sandbox.validatePath("npm install");
      expect(check.allowed).toBe(true);
    });

    it("should block directory traversal attempts", () => {
      const check = sandbox.validatePath("cat ../../../etc/passwd");
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("directory traversal");
    });

    it("should block access to sensitive paths", () => {
      const check = sandbox.validatePath("rm /etc/shadow");
      expect(check.allowed).toBe(false);
    });

    it("should allow relative paths within workspace", () => {
      const check = sandbox.validatePath("cat ./config.json");
      expect(check.allowed).toBe(true);
    });

    it("should block access outside allowed workspace paths", () => {
      const check = sandbox.validatePath("cat /var/log/system.log");
      expect(check.allowed).toBe(false);
    });
  });

  describe("Audit Logging", () => {
    it("should log command execution with approval status", async () => {
      await sandbox.logCommandExecution({
        command: "npm test",
        status: "ALLOW",
        exitCode: 0,
        timestamp: new Date(),
        userApproved: true,
      });

      const logs = sandbox.getAuditLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].command).toBe("npm test");
      expect(logs[0].status).toBe("ALLOW");
    });

    it("should record blocked command attempts", async () => {
      await sandbox.logCommandExecution({
        command: "rm -rf /",
        status: "DENY",
        timestamp: new Date(),
        reason: "blocked: rm -rf on root is dangerous",
      });

      const logs = sandbox.getAuditLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("DENY");
      expect(logs[0].reason).toContain("dangerous");
    });

    it("should record timeout events", async () => {
      await sandbox.logCommandExecution({
        command: "sleep 100",
        status: "TIMEOUT",
        timestamp: new Date(),
      });

      const logs = sandbox.getAuditLogs();
      expect(logs[0].status).toBe("TIMEOUT");
    });

    it("should format audit logs with timestamp and user info", () => {
      sandbox.logCommandExecutionSync({
        command: "git status",
        status: "ALLOW",
        exitCode: 0,
        timestamp: new Date("2026-07-16T10:30:00Z"),
        userApproved: true,
      });

      const content = fs.readFileSync(
        path.join(tempDir, "audit.log"),
        "utf-8"
      );
      expect(content).toContain("2026-07-16");
      expect(content).toContain("git status");
      expect(content).toContain("ALLOW");
    });
  });

  describe("Resource Limits", () => {
    it("should enforce timeout on long-running commands", async () => {
      const config: SandboxConfig = {
        auditLogPath: path.join(tempDir, "audit.log"),
        workspacePath: tempDir,
        timeoutMs: 100, // 100ms timeout
        allowedWorkspacePaths: [tempDir],
      };
      const timeoutSandbox = new AdvancedCommandSandbox(config);

      const result = await timeoutSandbox.executeWithTimeout("sleep 10", 100);
      expect(result.timedOut).toBe(true);
    });

    it("should allow commands that complete within timeout", async () => {
      const config: SandboxConfig = {
        auditLogPath: path.join(tempDir, "audit.log"),
        workspacePath: tempDir,
        timeoutMs: 5000,
        allowedWorkspacePaths: [tempDir],
      };
      const timeoutSandbox = new AdvancedCommandSandbox(config);

      const result = await timeoutSandbox.executeWithTimeout(
        'echo "test"',
        5000
      );
      expect(result.timedOut).toBe(false);
    });
  });

  describe("Config Validation", () => {
    it("should validate configuration completeness", () => {
      const validConfig: SandboxConfig = {
        auditLogPath: path.join(tempDir, "audit.log"),
        workspacePath: tempDir,
        allowedWorkspacePaths: [tempDir],
      };

      expect(() => new AdvancedCommandSandbox(validConfig)).not.toThrow();
    });

    it("should support loading from .champ/sandbox.yaml", () => {
      const configPath = path.join(tempDir, ".champ", "sandbox.yaml");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        `
allowlist:
  - npm run test
  - git status
denylist:
  - sudo
restrictedEnvVars:
  - SECRET
`
      );

      const loaded = AdvancedCommandSandbox.loadConfigFromYaml(configPath);
      expect(loaded).toBeDefined();
      expect(loaded?.allowlist).toContain("npm run test");
    });
  });

  describe("MCP Server Validation", () => {
    it("should validate MCP server commands", () => {
      const result = sandbox.validateMCPServerCommand({
        name: "my-server",
        command: "python",
        args: ["-m", "my_server"],
      });

      expect(result.allowed).toBe(true);
    });

    it("should block MCP servers with dangerous commands", () => {
      const result = sandbox.validateMCPServerCommand({
        name: "malicious",
        command: "rm",
        args: ["-rf", "/"],
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("dangerous");
    });

    it("should block MCP servers running as sudo", () => {
      const result = sandbox.validateMCPServerCommand({
        name: "privileged",
        command: "sudo",
        args: ["python", "server.py"],
      });

      expect(result.allowed).toBe(false);
    });

    it("should support whitelisting specific MCP servers", () => {
      const config: SandboxConfig = {
        auditLogPath: path.join(tempDir, "audit.log"),
        workspacePath: tempDir,
        allowedMCPServers: ["trusted-server"],
        allowedWorkspacePaths: [tempDir],
      };
      const trustedSandbox = new AdvancedCommandSandbox(config);

      const result = trustedSandbox.validateMCPServerCommand({
        name: "trusted-server",
        command: "python",
        args: ["-m", "server"],
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe("User Approval Tracking", () => {
    it("should track user approvals for new commands", () => {
      sandbox.recordApproval("npm test", true);
      expect(sandbox.isApprovalCached("npm test")).toBe(true);
    });

    it("should remember user denials", () => {
      sandbox.recordApproval("rm -rf /", false);
      expect(sandbox.isApprovalCached("rm -rf /")).toBe(false);
    });

    it("should clear approval cache on command pattern change", () => {
      sandbox.recordApproval("npm test", true);
      sandbox.clearApprovalCache();
      expect(sandbox.isApprovalCached("npm test")).toBeNull();
    });
  });
});
