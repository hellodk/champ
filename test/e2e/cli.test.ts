/**
 * End-to-end tests for the packaged headless CLI — issue #136.
 *
 * These treat `dist/cli.js` as a black box: a real process, a real workspace
 * on disk, a mock model endpoint. The point is the deliverable itself — the
 * `bin` artifact a user installs — not internal wiring.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  buildCli,
  frames,
  makeWorkspace,
  removeWorkspace,
  runCli,
  startMockOpenAI,
  writeChampConfig,
} from "../helpers/cli-harness";

const TIMEOUT = 30_000;
const ROOT = path.resolve(__dirname, "../..");

let workspaces: string[] = [];

beforeAll(async () => {
  await buildCli();
}, TIMEOUT);

afterAll(() => {
  for (const dir of workspaces) removeWorkspace(dir);
  workspaces = [];
});

describe("champ CLI — end to end", () => {
  it(
    "creates a file the agent is asked for",
    async () => {
      const ws = makeWorkspace("cli-e2e");
      workspaces.push(ws);
      const mock = await startMockOpenAI((_body, index) => {
        if (index === 0) {
          return [
            frames.toolCall("call_create", "create_file", {
              path: "greeting.txt",
              content: "hello from champ\n",
            }),
            frames.finish("tool_calls"),
            frames.usage(500, 30),
            frames.done,
          ];
        }
        return [
          frames.text("Created greeting.txt."),
          frames.finish("stop"),
          frames.usage(640, 12),
          frames.done,
        ];
      });

      try {
        const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl });
        const result = await runCli(
          ["create greeting.txt saying hello from champ", "--yes"],
          { cwd: ws, configPath },
        );

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Created greeting.txt.");

        const created = path.join(ws, "greeting.txt");
        expect(fs.existsSync(created)).toBe(true);
        expect(fs.readFileSync(created, "utf8")).toBe("hello from champ\n");

        // --yes silences the auto-approval note.
        expect(result.stderr).not.toContain("non-interactive run");
        expect(result.stderr).toContain("[tool] create_file");
      } finally {
        await mock.close();
      }
    },
    TIMEOUT,
  );

  it(
    "runs from any directory and works without a config for --version/--help",
    async () => {
      const ws = makeWorkspace("cli-e2e-elsewhere");
      workspaces.push(ws);

      const version = await runCli(["--version"], { cwd: ws });
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toBe(`champ ${pkgVersion()}`);

      const help = await runCli(["--help"], { cwd: ws });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("headless Champ agent CLI");
    },
    TIMEOUT,
  );

  it(
    "lists stored sessions without needing a provider (--sessions)",
    async () => {
      const ws = makeWorkspace("cli-e2e-sessions");
      workspaces.push(ws);

      // No config at all: listing is a read-only workspace query.
      const empty = await runCli(["--sessions"], { cwd: ws });
      expect(empty.timedOut).toBe(false);
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain("no sessions in");
      expect(empty.stdout).toContain(".champ/sessions");

      const mock = await startMockOpenAI(() => [
        frames.text("noted"),
        frames.finish("stop"),
        frames.usage(90, 4),
        frames.done,
      ]);
      try {
        const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl });
        const run = await runCli(["--session", "sess-e2e", "hello"], {
          cwd: ws,
          configPath,
        });
        expect(run.code).toBe(0);
        expect(run.stderr).toContain("session sess-e2e");

        const listed = await runCli(["--sessions"], { cwd: ws });
        expect(listed.code).toBe(0);
        expect(listed.stdout).toContain("sess-e2e");
        expect(listed.stdout).toContain("messages=");
        expect(listed.stdout).toContain("checkpoints=0");
      } finally {
        await mock.close();
      }
    },
    TIMEOUT,
  );

  it(
    "reports a session log with a torn header instead of 'already exists' (review 3)",
    async () => {
      const ws = makeWorkspace("cli-e2e-corrupt-session");
      workspaces.push(ws);
      const mock = await startMockOpenAI(() => [
        frames.text("noted"),
        frames.finish("stop"),
        frames.usage(90, 4),
        frames.done,
      ]);
      try {
        const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl });
        // A crash mid-write leaves a log whose header is a fragment. `open`
        // must say the log is corrupt — reporting "does not exist" sends the
        // CLI to create the id again, which then fails with a contradictory
        // "already exists" and can never succeed.
        const dir = path.join(ws, ".champ", "sessions");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "broken.jsonl"),
          '{"v":1,"kind":"head',
          "utf8",
        );

        const run = await runCli(["--session", "broken", "hello"], {
          cwd: ws,
          configPath,
        });

        expect(run.code).toBe(2);
        expect(run.stderr).toContain("corrupt session log");
        expect(run.stderr).toContain("broken.jsonl");
        expect(run.stderr).not.toContain("already exists");
        // Review pass 2: the user is told how to get unstuck, not just that
        // the file is corrupt.
        expect(run.stderr).toContain("delete");
        expect(run.stderr).toContain("--session");
      } finally {
        await mock.close();
      }
    },
    TIMEOUT,
  );

  it(
    "keeps a huge tool result out of the request it sends next (review 2)",
    async () => {
      const ws = makeWorkspace("cli-e2e-tool-budget");
      workspaces.push(ws);
      // 200 KB on one line: more than a small local window holds, and the
      // formatter would happily emit it whole (one line is under the cap).
      const huge = "x".repeat(200_000);
      fs.writeFileSync(path.join(ws, "big.txt"), huge, "utf8");

      const mock = await startMockOpenAI((_body, index) => {
        if (index === 0) {
          return [
            frames.toolCall("call_read", "read_file", { path: "big.txt" }),
            frames.finish("tool_calls"),
            frames.usage(500, 30),
            frames.done,
          ];
        }
        return [
          frames.text("Read it."),
          frames.finish("stop"),
          frames.usage(640, 12),
          frames.done,
        ];
      });

      try {
        const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl });
        const run = await runCli(["read big.txt", "--yes"], {
          cwd: ws,
          configPath,
        });
        expect(run.timedOut).toBe(false);
        expect(run.code).toBe(0);

        // The next turn re-sends the tool result: it has to be the budgeted
        // copy, not the whole file, or a small model's window is gone after
        // one read.
        const second = JSON.stringify(mock.requests[1].messages);
        expect(second).toContain("chars elided");
        expect(second).not.toContain(huge.slice(0, 5_000));
        expect(second.length).toBeLessThan(30_000);
      } finally {
        await mock.close();
      }
    },
    TIMEOUT,
  );

  it("ships as an executable, vscode-free bin artifact", () => {
    const artifact = path.join(ROOT, "dist", "cli.js");
    const source = fs.readFileSync(artifact, "utf8");
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
    // Headless guarantee: nothing in the bundle can require the VS Code API.
    expect(source).not.toContain('require("vscode")');
    // Executable, so `bin` installs and local runs both work.
    expect(fs.statSync(artifact).mode & 0o111).not.toBe(0);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { bin?: Record<string, string>; version?: string };
    expect(manifest.bin?.champ).toBe("dist/cli.js");
  });
});

/** Version from the package manifest, read the same way the CLI does. */
function pkgVersion(): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "unknown";
}
