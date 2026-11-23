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
import * as http from "http";
import * as path from "path";
import type { AddressInfo } from "net";
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
  budget?: { maxTokensPerRun?: number; maxUsdPerRun?: number },
) {
  const ws = makeWorkspace("cli-int");
  const mock: MockOpenAI = await startMockOpenAI(responder);
  const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl, budget });
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

        // Explicit --yes opts in to auto-approval for this headless run.
        const result = await s.run([
          "--yes",
          "replace before with after in hello.txt",
        ]);

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
        expect(result.stderr).not.toContain(
          "actions requiring approval are denied",
        );

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
    "denies approval-required tools in a headless run without --yes",
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
            frames.usage(100, 5),
            frames.done,
          ];
        }
        return [
          frames.text("I could not change the file without approval."),
          frames.finish("stop"),
          frames.usage(100, 5),
          frames.done,
        ];
      });

      try {
        const file = path.join(s.ws, "hello.txt");
        fs.writeFileSync(file, "before\n", "utf8");

        const result = await s.run(["replace before with after in hello.txt"]);

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        // The mutating tool never touched disk.
        expect(fs.readFileSync(file, "utf8")).toBe("before\n");
        expect(result.stderr).toContain(
          "actions requiring approval are denied",
        );
        // The denial is fed back to the model as the tool result.
        const followUp = s.mock.requests[1] as {
          messages: Array<{ role: string; content: unknown }>;
        };
        expect(JSON.stringify(followUp.messages)).toContain("headless");
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
    "enforces a configured token budget from actual provider usage",
    async () => {
      const s = await scenario(
        (_body, index) => {
          if (index === 0) {
            return [
              frames.toolCall("call_read", "read_file", { path: "hello.txt" }),
              frames.finish("tool_calls"),
              frames.usage(500, 20),
              frames.done,
            ];
          }
          return [
            frames.text("should not be reached"),
            frames.finish("stop"),
            frames.usage(10, 1),
            frames.done,
          ];
        },
        { maxTokensPerRun: 50 },
      );

      try {
        fs.writeFileSync(path.join(s.ws, "hello.txt"), "content\n", "utf8");
        const result = await s.run(["--yes", "read hello.txt"]);
        expect(result.timedOut).toBe(false);
        // The first call recorded 520 actual tokens, exceeding the 50 budget;
        // the follow-up call was blocked before hitting the provider again.
        expect(s.mock.requests).toHaveLength(1);
        expect(result.stderr).toContain("Budget exceeded");
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

        // No CHAMP_CONFIG and an empty CHAMP_HOME → no provider anywhere.
        const emptyHome = path.join(s.ws, "empty-home-errors");
        fs.mkdirSync(emptyHome, { recursive: true });
        const noConfig = await runCli(["do something"], {
          cwd: s.ws,
          configPath: path.join(s.ws, "missing.yaml"),
          env: { CHAMP_HOME: emptyHome },
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

  it(
    "exits non-zero when the provider reports a failed turn",
    async () => {
      const ws = makeWorkspace("cli-provider-error");
      fixtures.push(ws);
      const failing = http.createServer((_req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
      await new Promise<void>((resolve) =>
        failing.listen(0, "127.0.0.1", resolve),
      );
      const { port } = failing.address() as AddressInfo;
      const configPath = writeChampConfig(ws, {
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });

      try {
        const result = await runCli(["-y", "do something"], {
          cwd: ws,
          configPath,
        });
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Request failed: 404");
      } finally {
        await new Promise<void>((resolve) => failing.close(() => resolve()));
      }
    },
    TIMEOUT,
  );

  it(
    "ignores the developer's real ~/.champ/providers.json",
    async () => {
      const ws = makeWorkspace("cli-no-home-leak");
      fixtures.push(ws);
      const emptyHome = path.join(ws, "empty-home");
      fs.mkdirSync(emptyHome, { recursive: true });

      const result = await runCli(["do something"], {
        cwd: ws,
        configPath: path.join(ws, "missing.yaml"),
        env: { CHAMP_HOME: emptyHome },
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("no provider configured");
    },
    TIMEOUT,
  );
});

describe("champ CLI — persistent sessions (--session, issue #72)", () => {
  it(
    "resumes a stored session and sends its history back to the model",
    async () => {
      const s = await scenario((_body, index) => [
        frames.text(`reply ${index}`),
        frames.finish("stop"),
        frames.usage(100, 5),
        frames.done,
      ]);

      try {
        const logFile = path.join(
          s.ws,
          ".champ",
          "sessions",
          "sess-demo.jsonl",
        );

        const first = await s.run([
          "--session",
          "sess-demo",
          "--yes",
          "remember the word pineapple",
        ]);
        expect(first.timedOut).toBe(false);
        expect(first.code).toBe(0);
        expect(first.stderr).toContain("session sess-demo");
        expect(fs.existsSync(logFile)).toBe(true);

        const records = fs
          .readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind: string });
        expect(records[0].kind).toBe("header");
        expect(records.some((record) => record.kind === "messages")).toBe(true);

        const second = await s.run([
          "--session",
          "sess-demo",
          "--yes",
          "what word did I ask you to remember?",
        ]);
        expect(second.code).toBe(0);
        expect(second.stderr).toContain("resumed session sess-demo");

        // The second request carries the first run's turn, and the new one.
        const request = s.mock.requests[1] as {
          messages: Array<{ role: string; content: unknown }>;
        };
        const wire = JSON.stringify(request.messages);
        expect(wire).toContain("remember the word pineapple");
        expect(wire).toContain("reply 0");
        expect(wire).toContain("what word did I ask you to remember?");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "bounds a resumed session at the newest checkpoint (/checkpoint, /compact)",
    async () => {
      const s = await scenario(() => [
        frames.text("ok"),
        frames.finish("stop"),
        frames.usage(50, 3),
        frames.done,
      ]);

      try {
        const repl = await s.run(["--repl"], {
          dialog: [
            { match: "champ> ", stream: "stdout", send: "first turn\n" },
            {
              match: "champ> ",
              stream: "stdout",
              send: "/checkpoint milestone\n",
            },
            { match: "champ> ", stream: "stdout", send: "second turn\n" },
            { match: "champ> ", stream: "stdout", send: "/compact\n" },
            { match: "champ> ", stream: "stdout", send: "/exit\n" },
          ],
        });

        expect(repl.timedOut).toBe(false);
        expect(repl.code).toBe(0);
        expect(repl.stderr).toContain('checkpoint "milestone" at 2 messages');
        expect(repl.stderr).toContain("compacted sess-");

        const id = repl.stderr.match(/session (sess-[0-9a-f-]+)/)?.[1];
        expect(id).toBeDefined();

        // Compaction left exactly the header, the checkpoint and the
        // post-checkpoint turn on disk.
        const logFile = path.join(s.ws, ".champ", "sessions", `${id}.jsonl`);
        const records = fs
          .readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind: string; upTo?: number });
        expect(records.map((record) => record.kind)).toEqual([
          "header",
          "checkpoint",
          "messages",
        ]);
        expect(records[1].upTo).toBe(0);

        const resumed = await s.run([
          "--session",
          id!,
          "--yes",
          "what did we discuss?",
        ]);
        expect(resumed.code).toBe(0);
        expect(repl.stderr).toContain("compact");
        expect(resumed.stderr).toContain(`resumed session ${id}`);
        expect(resumed.stderr).toContain('checkpoint "milestone"');

        // Context is bounded: the pre-checkpoint turn is gone, the newer one
        // is not, and the injected note says where the boundary is.
        const request = s.mock.requests[s.mock.requests.length - 1] as {
          messages: Array<{ role: string; content: unknown }>;
        };
        const wire = JSON.stringify(request.messages);
        expect(wire).not.toContain("first turn");
        expect(wire).toContain("second turn");
        expect(wire).toContain("resumes at checkpoint");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "rejects an invalid session id before touching the network",
    async () => {
      const s = await scenario(() => [frames.done]);
      try {
        const result = await s.run(["--session", "../escape", "task"]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("invalid session id");
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
