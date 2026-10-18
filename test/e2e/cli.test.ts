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
