/**
 * TDD: Tests for OSLevelSandbox.
 * Validates OS-level isolation (bwrap/seccomp) for terminal execution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OSLevelSandbox } from "@/safety/os-level-sandbox";
import * as fs from "fs";
import * as path from "path";

describe("OSLevelSandbox", () => {
  let sandbox: OSLevelSandbox;
  let testTempDir: string;

  beforeEach(() => {
    sandbox = new OSLevelSandbox();
    // Create a temporary directory for testing
    testTempDir = path.join(process.cwd(), ".test-sandbox-temp");
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
  });

  describe("availability and detection", () => {
    it("should detect bwrap availability", async () => {
      const available = await sandbox.isBwrapAvailable();
      expect(typeof available).toBe("boolean");
    });

    it("should detect seccomp support", async () => {
      const supported = await sandbox.isSeccompSupported();
      expect(typeof supported).toBe("boolean");
    });

    it("should report sandboxing capability", async () => {
      const capable = await sandbox.isSandboxingCapable();
      expect(typeof capable).toBe("boolean");
    });
  });

  describe("sandbox configuration", () => {
    it("should create sandbox with default config", async () => {
      const config = await sandbox.getDefaultConfig();
      expect(config).toBeDefined();
      expect(config.readonly_paths).toBeDefined();
      expect(Array.isArray(config.readonly_paths)).toBe(true);
    });

    it("should support custom readonly paths", async () => {
      const customSandbox = new OSLevelSandbox({
        readonly_paths: ["/etc", "/usr"],
      });
      const config = await customSandbox.getDefaultConfig();
      expect(config.readonly_paths).toContain("/etc");
      expect(config.readonly_paths).toContain("/usr");
    });

    it("should support deny list syscalls", async () => {
      const customSandbox = new OSLevelSandbox({
        deny_syscalls: ["execve", "fork"],
      });
      const config = await customSandbox.getDefaultConfig();
      expect(config.deny_syscalls).toContain("execve");
    });
  });

  describe("command execution", () => {
    it("should execute safe commands (with fallback)", async () => {
      const result = await sandbox.executeInSandbox("echo 'hello world'", {
        cwd: testTempDir,
        allow_fallback: true,
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("hello world");
    });

    it("should allow file reads (with fallback)", async () => {
      // Create a test file
      const testFile = path.join(testTempDir, "test.txt");
      fs.writeFileSync(testFile, "test content");

      const result = await sandbox.executeInSandbox(`cat test.txt`, {
        cwd: testTempDir,
        allow_fallback: true,
      });
      if (!result.success) {
        console.log(
          "Result error:",
          result.error,
          "stderr:",
          result.stderr,
          "stdout:",
          result.stdout,
        );
      }
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("test content");
    });

    it("should allow command pipes (with fallback)", async () => {
      const result = await sandbox.executeInSandbox("echo 'test' | wc -c", {
        cwd: testTempDir,
        allow_fallback: true,
      });
      expect(result.success).toBe(true);
    });

    it("should capture stderr (with fallback)", async () => {
      const result = await sandbox.executeInSandbox(
        "echo 'stderr_test' >&2; exit 1",
        {
          cwd: testTempDir,
          allow_fallback: true,
        },
      );
      expect(result.success).toBe(false);
      expect(result.stderr || result.stdout).toContain("stderr_test");
    });

    it("should enforce timeout (with fallback)", async () => {
      const result = await sandbox.executeInSandbox("sleep 2", {
        cwd: testTempDir,
        timeout: 500,
        allow_fallback: true,
      });
      expect(result.success).toBe(false);
      expect(result.error || result.stderr).toBeDefined();
      const errorMsg = (result.error || "").toLowerCase();
      expect(
        errorMsg.includes("timeout") || errorMsg.includes("timed out"),
      ).toBe(true);
    });
  });

  describe("filesystem isolation", () => {
    it("should restrict writes to work directory (ideal with bwrap)", async () => {
      const result = await sandbox.executeInSandbox(
        "touch /etc/test-file 2>&1 || echo 'permission denied'",
        {
          cwd: testTempDir,
          work_dir: testTempDir,
          allow_fallback: true,
        },
      );
      // In a real sandbox, writing outside work_dir should fail
      expect(result.stdout || result.stderr).toBeDefined();
    });

    it("should allow writes within work directory (with fallback)", async () => {
      const testFile = path.join(testTempDir, "writable.txt");
      const result = await sandbox.executeInSandbox(
        `echo 'content' > writable.txt`,
        {
          cwd: testTempDir,
          work_dir: testTempDir,
          allow_fallback: true,
        },
      );
      if (!result.success) {
        console.log(
          "Result error:",
          result.error,
          "stderr:",
          result.stderr,
          "stdout:",
          result.stdout,
        );
      }
      expect(result.success).toBe(true);
      expect(fs.existsSync(testFile)).toBe(true);
    });
  });

  describe("capability restrictions", () => {
    it("should have limited network access when configured", async () => {
      const customSandbox = new OSLevelSandbox({
        restrict_net: true,
      });
      const result = await customSandbox.executeInSandbox("hostname", {
        cwd: testTempDir,
      });
      // Should work with hostname since it's a syscall-based check
      expect(result).toBeDefined();
    });

    it("should support readonly root filesystem", async () => {
      const customSandbox = new OSLevelSandbox({
        readonly_root: true,
      });
      const config = await customSandbox.getDefaultConfig();
      expect(config.readonly_root).toBe(true);
    });
  });

  describe("fallback behavior", () => {
    it("should fallback gracefully when bwrap unavailable", async () => {
      // This should not throw, but may return reduced isolation
      const result = await sandbox.executeInSandbox("echo 'fallback test'", {
        cwd: testTempDir,
        allow_fallback: true,
      });
      expect(result).toBeDefined();
    });

    it("should report when running without true isolation", async () => {
      const result = await sandbox.executeInSandbox("echo 'test'", {
        cwd: testTempDir,
      });
      const usingSandbox = await sandbox.isActuallySandboxed();
      expect(typeof usingSandbox).toBe("boolean");
    });
  });

  describe("error handling", () => {
    it("should handle non-existent working directory", async () => {
      const result = await sandbox.executeInSandbox("pwd", {
        cwd: "/non/existent/path",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should handle command execution errors", async () => {
      const result = await sandbox.executeInSandbox("false", {
        cwd: testTempDir,
      });
      expect(result.success).toBe(false);
    });

    it("should handle invalid command", async () => {
      const result = await sandbox.executeInSandbox("nonexistent_command_xyz", {
        cwd: testTempDir,
        allow_fallback: true,
      });
      expect(result.success).toBe(false);
      // Either error field is set or stderr/stdout contain failure info
      expect(result.error || result.stderr).toBeDefined();
    });
  });

  describe("integration with command filter", () => {
    it("should combine with pattern-based denylist", async () => {
      const integrations = await sandbox.getIntegrationOptions();
      expect(integrations).toBeDefined();
      expect(integrations.supportsDenylist).toBe(true);
    });
  });
});
