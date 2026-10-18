/**
 * Integration tests for the headless `champ` CLI — issue #136.
 *
 * These run the real `dist/cli.js` artifact (the `bin` target) as a child
 * process against a local mock OpenAI-compatible server, driving complete
 * agent turns: read → edit → reply, piped stdin, and an interactive REPL
 * session with a scripted approval prompt.
 *
 * Every run is hermetic: a throwaway workspace plus a CHAMP_CONFIG file, so
 * the developer's ~/.champ/config.yaml can never influence the result.
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
  type MockOpenAI,
  type SseFrame,
} from "../helpers/cli-harness";

const TIMEOUT = 30_000;

let fixtures: string[] = [];

/** Everything a single test needs: a workspace, a mock server, its config. */
async function scenario(
  responder: (_body: unknown, index: number) => SseFrame[],
) {
  const ws = makeWorkspace("cli-int");
  const mock: MockOpenAI = await startMockOpenAI(responder);
  const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl });
  const fixture = { ws, mock, configPath };
  fixtures.push(ws);
  return {
    ...fixture,
    run: (args: string[], opts: Record<string, unknown> = {}) =>
      runCli(args, { cwd: ws, configPath, ...opts }),
    close: async () => {
      await mock.close();
    },
  };
}

beforeAll(async () => {
  await buildCli();
}, TIMEOUT);

afterAll(() => {
  for (const dir of fixtures) removeWorkspace(dir);
  fixtures = [];
});

describe("champ CLI — one-shot agent turn (dist/cli.js)", () => {
  it(
    "completes a read → edit → reply turn against the workspace",
    async () => {
      const s = await scenario((_body, index) => {
        if (index === 0) {
          return [
            frames.toolCall("call_read", "read_file", { path: "hello.txt" }),
            frames.finish("tool_calls"),
            frames.usage(1200, 64),
            frames.done,
          ];
        }
        if (index === 1) {
          return [
            frames.toolCall("call_edit", "edit_file", {
              path: "hello.txt",
              old_content: "before",
              new_content: "after",
            }),
            frames.finish("tool_calls"),
            frames.usage(1500, 88),
            frames.done,
          ];
        }
        return [
          frames.text("Updated hello.txt: before → after."),
          frames.finish("stop"),
          frames.usage(1800, 42),
          frames.done,
        ];
      });

      try {
        const file = path.join(s.ws, "hello.txt");
        fs.writeFileSync(file, "before\n", "utf8");

        // No --yes: non-interactive runs still approve, and say so.
        const result = await s.run(["replace before with after in hello.txt"]);

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);

        // The tool side effect landed on disk.
        expect(fs.readFileSync(file, "utf8")).toBe("after\n");

        // stdout carries the reply and nothing else.
        expect(result.stdout).toContain("Updated hello.txt: before → after.");
        expect(result.stdout).not.toContain("[tool]");
        expect(result.stdout).not.toContain("[champ]");

        // Traces and the per-turn summary go to stderr.
        expect(result.stderr).toContain("[tool] read_file");
        expect(result.stderr).toContain("[tool] edit_file");
        expect(result.stderr).toContain(
          "[champ] tools=2 tokens in=1800 out=42",
        );
        expect(result.stderr).toContain("non-interactive run");

        // The mock saw a well-formed OpenAI request sequence.
        expect(s.mock.requests).toHaveLength(3);
        const first = s.mock.requests[0] as {
          model?: string;
          stream?: boolean;
          tools?: unknown[];
          messages?: Array<{ role: string }>;
        };
        expect(first.model).toBe("mock-model");
        expect(first.stream).toBe(true);
        expect(Array.isArray(first.tools)).toBe(true);
        expect(first.tools!.length).toBeGreaterThan(0);

        // Later turns carry the tool results back to the model. The
        // OpenAI-compatible provider normalizes `role: "tool"` to `"user"`
        // with flattened text (openai-compatible.ts: convertToWire), so
        // assert on the round-tripped output instead of the role.
        const third = s.mock.requests[2] as {
          messages: Array<{ role: string; content: string }>;
        };
        expect(third.messages.length).toBeGreaterThan(first.messages!.length);
        const wire = JSON.stringify(third.messages);
        expect(wire).toContain("1: before"); // read_file returned the file
        expect(wire).toContain("Staged edit for hello.txt"); // edit_file result
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "reads the task from stdin with `-` and prints only the reply",
    async () => {
      const s = await scenario(() => [
        frames.text("Piped tasks work."),
        frames.finish("stop"),
        frames.usage(310, 7),
        frames.done,
      ]);

      try {
        const result = await s.run(["-"], {
          stdin: "say something reassuring about pipes",
        });

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        // Byte-exact: stdout is machine-readable output only.
        expect(result.stdout).toBe("Piped tasks work.\n");
        expect(result.stderr).toContain("[champ] tools=0 tokens in=310 out=7");
        expect(s.mock.requests).toHaveLength(1);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "exits 2 on usage and configuration errors",
    async () => {
      const s = await scenario(() => [frames.done]);
      try {
        const unknownFlag = await s.run(["--bogus", "task"]);
        expect(unknownFlag.code).toBe(2);
        expect(unknownFlag.stderr).toContain("Unknown option: --bogus");

        const unknownProvider = await s.run([
          "--provider",
          "not-a-provider",
          "task",
        ]);
        expect(unknownProvider.code).toBe(2);
        expect(unknownProvider.stderr).toContain(
          'unknown provider "not-a-provider"',
        );

        // No CHAMP_CONFIG → no provider configured anywhere.
        const noConfig = await runCli(["do something"], {
          cwd: s.ws,
          configPath: path.join(s.ws, "missing.yaml"),
        });
        expect(noConfig.code).toBe(2);
        expect(noConfig.stderr).toContain("no provider configured");
        // Nothing reached the model.
        expect(s.mock.requests).toHaveLength(0);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );
});

describe("champ CLI — interactive REPL (--repl)", () => {
  it(
    "streams a turn, prompts for approval, then exits on /exit",
    async () => {
      const s = await scenario((_body, index) => {
        if (index === 0) {
          return [
            frames.toolCall("call_edit", "edit_file", {
              path: "hello.txt",
              old_content: "before",
              new_content: "after",
            }),
            frames.finish("tool_calls"),
            frames.usage(900, 55),
            frames.done,
          ];
        }
        return [
          frames.text("Done — hello.txt now says after."),
          frames.finish("stop"),
          frames.usage(1100, 33),
          frames.done,
        ];
      });

      try {
        const file = path.join(s.ws, "hello.txt");
        fs.writeFileSync(file, "before\n", "utf8");

        const result = await s.run(["--repl"], {
          stdin: "update hello.txt\n",
          // readline prints the approval question and the prompt to stdout;
          // answer the question, then leave the session.
          dialog: [
            { match: "Allow?", stream: "stdout", send: "y\n" },
            { match: "champ> ", stream: "stdout", send: "/exit\n" },
          ],
        });

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("champ> ");
        expect(result.stdout).toContain("Done — hello.txt now says after.");
        expect(fs.readFileSync(file, "utf8")).toBe("after\n");
        expect(s.mock.requests).toHaveLength(2);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );
});
