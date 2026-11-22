/**
 * Security regression tests for the execution backend abstraction.
 *
 * Contracts:
 * - child processes never inherit the full parent environment
 * - cwd and filesystem scope are validated before spawn
 * - OS isolation is only claimed when the backend can actually provide it
 * - cancellation and timeouts kill the whole process tree
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import {
  LocalExecutionBackend,
  BubblewrapExecutionBackend,
  createExecutionBackend,
  type ExecutionRequest,
} from "@/safety/execution-backend";

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    argv: [process.execPath, "-e", "process.stdout.write('ok')"],
    cwd: process.cwd(),
    allowedPaths: [process.cwd()],
    allowNetwork: false,
    envAllowlist: [],
    env: {},
    limits: { timeoutMs: 5_000, maxOutputBytes: 10_000 },
    ...overrides,
  };
}

describe("LocalExecutionBackend", () => {
  it("does not inherit process.env", async () => {
    process.env.CHAMP_SECRET_CANARY = "must-not-leak";
    const backend = new LocalExecutionBackend();
    const result = await backend.execute(
      request({
        envAllowlist: ["PATH"],
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify(process.env))",
        ],
      }),
    );
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env.CHAMP_SECRET_CANARY).toBeUndefined();
    expect(env.PATH).toBeDefined();
    delete process.env.CHAMP_SECRET_CANARY;
  });

  it("rejects a cwd outside the allowed filesystem scope", async () => {
    const backend = new LocalExecutionBackend();
    const result = await backend.execute(
      request({
        cwd: path.parse(process.cwd()).root,
        allowedPaths: [process.cwd()],
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/scope|allowed/i);
  });

  it("rejects dangerous environment variable names", async () => {
    const backend = new LocalExecutionBackend();
    const result = await backend.execute(
      request({ env: { LD_PRELOAD: "/tmp/evil.so" } }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/environment/i);
  });

  it("reports no OS isolation instead of claiming a sandbox it does not have", () => {
    const backend = new LocalExecutionBackend();
    expect(backend.isolation.level).toBe("none");
    expect(backend.isolation.verified).toBe(false);
  });

  it("kills the process tree on timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-tree-"));
    const marker = path.join(dir, "survived");
    const backend = new LocalExecutionBackend();
    const result = await backend.execute(
      request({
        argv: ["bash", "-c", `(sleep 5; touch ${marker}) & echo $!; wait`],
        limits: { timeoutMs: 300, maxOutputBytes: 1000 },
      }),
    );
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("BubblewrapExecutionBackend", () => {
  it("only advertises OS isolation after a successful bwrap probe", () => {
    const unavailable = new BubblewrapExecutionBackend({
      platform: "linux",
      commandExists: () => false,
      probeVersion: () => null,
    });
    expect(unavailable.isolation.level).toBe("none");
    expect(unavailable.isolation.verified).toBe(false);

    const available = new BubblewrapExecutionBackend({
      platform: "linux",
      commandExists: () => true,
      probeVersion: () => "bubblewrap 0.8.0",
    });
    expect(available.isolation.level).toBe("os");
    expect(available.isolation.verified).toBe(true);
  });

  it("passes unshare, env reset, and workspace-only binds when isolated", async () => {
    const captured: { args?: string[]; opts?: Record<string, unknown> } = {};
    const backend = new BubblewrapExecutionBackend({
      platform: "linux",
      commandExists: () => true,
      probeVersion: () => "bubblewrap 0.8.0",
      spawn: ((cmd: string, args: string[], opts: unknown) => {
        captured.args = args;
        captured.opts = opts as Record<string, unknown>;
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 1;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("ok"));
          child.emit("close", 0, null);
        });
        return child as never;
      }) as never,
    });
    await backend.execute(
      request({
        cwd: process.cwd(),
        allowedPaths: [process.cwd()],
        envAllowlist: ["PATH"],
      }),
    );
    const args = captured.args ?? [];
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--unsetenv");
    expect(args).toContain("--die-with-parent");
    expect(args).not.toContain("--share-net");
    expect(args).toContain(process.cwd());
    expect(captured.opts?.env).toEqual({});
  });

  it("refuses network access by default even when isolation is unavailable", async () => {
    const backend = new BubblewrapExecutionBackend({
      platform: "linux",
      commandExists: () => false,
      probeVersion: () => null,
    });
    const result = await backend.execute(request());
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/isolation|unavailable/i);
  });
});

describe("createExecutionBackend", () => {
  it("does not silently downgrade when OS isolation is required", () => {
    expect(() =>
      createExecutionBackend({
        requireIsolation: "os",
        platform: "linux",
        commandExists: () => false,
        probeVersion: () => null,
      }),
    ).toThrow(/isolation/i);
  });

  it("returns the explicitly non-isolated backend when isolation is optional", () => {
    const backend = createExecutionBackend({
      requireIsolation: "none",
      platform: "linux",
      commandExists: () => false,
      probeVersion: () => null,
    });
    expect(backend.isolation.level).toBe("none");
  });
});
