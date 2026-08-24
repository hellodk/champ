/**
 * Validates command execution over SSH, output capture, timeout, and
 * sandboxing.
 *
 * The tool shells out through child_process.exec(`ssh ...`). These tests
 * mock exec so nothing ever touches a real network — an sshd listening on
 * localhost:22 previously made three of these tests hang until the vitest
 * timeout on developer machines that run one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

const execMock = vi.fn();
vi.mock("child_process", () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

import { remoteRunTerminalTool } from "@/tools/remote-run-terminal";
import type { ToolExecutionContext } from "@/tools/types";

interface FakeChild {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

/** Install execMock to return `child` and capture its invocation. */
function stubExec(child: FakeChild): { cmd: string; opts: unknown } {
  const captured = { cmd: "", opts: undefined as unknown };
  execMock.mockImplementation((cmd: string, opts: unknown) => {
    captured.cmd = cmd;
    captured.opts = opts;
    return child;
  });
  return captured;
}

describe("remote run_terminal_cmd tool", () => {
  let context: ToolExecutionContext;

  beforeEach(() => {
    execMock.mockReset();
    context = {
      workspaceRoot: "/test",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
    };
  });

  it("should have correct metadata", () => {
    expect(remoteRunTerminalTool.name).toBe("remote_run_terminal_cmd");
    expect(remoteRunTerminalTool.requiresApproval).toBe(true);
    expect(remoteRunTerminalTool.parameters.required).toContain("command");
    expect(remoteRunTerminalTool.parameters.required).toContain("remote");
  });

  it("should validate required remote target", async () => {
    const result = await remoteRunTerminalTool.execute(
      { command: 'echo "hello"', remote: "" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("remote");
  });

  it("should validate SSH connection parameters", async () => {
    const result = await remoteRunTerminalTool.execute(
      { command: "ls", remote: "invalid-format" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid remote target format");
  });

  it("should parse valid SSH remote format (user@host:port)", async () => {
    // Valid format proceeds past parsing to spawning the SSH process.
    // The exec mock fails fast — no real network involved.
    const child = makeFakeChild();
    const captured = stubExec(child);

    const p = remoteRunTerminalTool.execute(
      { command: 'echo "test"', remote: "user@localhost:22" },
      context,
    );
    // Let the tool attach its listeners, then settle the fake process.
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const result = await p;
    expect(captured.cmd).toContain("ssh -p 22 user@localhost");
    expect(result.output).not.toContain("Invalid remote target format");
    expect(result.output).toContain("Exit code: 0");
  });

  it("should block dangerous commands via sandbox on remote", async () => {
    const result = await remoteRunTerminalTool.execute(
      {
        command: "rm -rf /",
        remote: "user@localhost:22",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("blocked");
    expect(execMock).not.toHaveBeenCalled(); // never spawns anything
  });

  it("should respect timeout on remote execution", async () => {
    const child = makeFakeChild();
    const captured = stubExec(child);

    const p = remoteRunTerminalTool.execute(
      { command: "sleep 100", remote: "user@host:22", timeout: 50 },
      context,
    );
    await new Promise((r) => setImmediate(r));

    // The tool's own timer kills the child after timeoutMs...
    await new Promise((r) => setTimeout(r, 90));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(captured.opts).toMatchObject({ timeout: 50 });
    // ...then the process close event settles the result.
    child.emit("close", null, "SIGKILL");

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
  });

  it("should buffer output correctly", async () => {
    const child = makeFakeChild();
    stubExec(child);

    const p = remoteRunTerminalTool.execute(
      { command: "echo hello", remote: "user@host:22" },
      context,
    );
    await new Promise((r) => setImmediate(r));

    child.stdout.emit("data", Buffer.from("hello "));
    child.stdout.emit("data", Buffer.from("world\n"));
    child.stderr.emit("data", Buffer.from("a warning\n"));
    child.emit("close", 0);

    const result = await p;
    expect(result.success).toBe(true);
    expect(result.output).toContain("STDOUT:\nhello world");
    expect(result.output).toContain("STDERR:\na warning");
    expect(result.output).toContain("Exit code: 0");
  });

  it("should pass through abort signal", async () => {
    const controller = new AbortController();
    const abortContext: ToolExecutionContext = {
      ...context,
      abortSignal: controller.signal,
    };
    const child = makeFakeChild();
    stubExec(child);

    const p = remoteRunTerminalTool.execute(
      { command: "long-task", remote: "user@host:22" },
      abortContext,
    );
    await new Promise((r) => setImmediate(r));

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null, "SIGTERM");
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.output).toContain("signal SIGTERM");
  });
});
