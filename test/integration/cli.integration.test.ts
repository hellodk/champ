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
        // Usage accumulates across all 3 requests (1200+1500+1800=4500, 64+88+42=194)
        // while context reflects the final request (1800+42=1,842).
        expect(result.stderr).toContain(
          "[champ] tools=2 tokens in=4500 out=194",
        );
        expect(result.stderr).toContain("context=1,842/8,192");
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
    "read-only profile blocks a mutation even when --yes is supplied",
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
          frames.text("I could not change the file in a read-only session."),
          frames.finish("stop"),
          frames.usage(100, 5),
          frames.done,
        ];
      });

      try {
        const file = path.join(s.ws, "hello.txt");
        fs.writeFileSync(file, "before\n", "utf8");

        const result = await s.run([
          "--yes",
          "--permission-profile",
          "read-only",
          "replace before with after in hello.txt",
        ]);

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        expect(fs.readFileSync(file, "utf8")).toBe("before\n");
        expect(result.stderr).toContain("read-only profile");

        const followUp = s.mock.requests[1] as {
          messages: Array<{ role: string; content: unknown }>;
        };
        expect(JSON.stringify(followUp.messages)).toContain(
          "read-only profile denies",
        );
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
    "reports index status and clears the cache without a task",
    async () => {
      const s = await scenario(() => []);
      try {
        const status = await s.run(["index", "--status"]);
        expect(status.code).toBe(0);
        expect(status.stdout).toContain("Status: stale");
        expect(status.stdout).toContain("Reason: no persisted index");
        expect(status.stdout).toContain("Last indexed: never");

        const cleared = await s.run(["index", "--clear"]);
        expect(cleared.code).toBe(0);
        expect(cleared.stdout).toContain("Index cache cleared.");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "rejects conflicting index actions with a usage error",
    async () => {
      const s = await scenario(() => []);
      try {
        const result = await s.run(["index", "--status", "--clear"]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("only one of");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "attaches repo map and memory banks to the outbound system prompt",
    async () => {
      const s = await scenario((_body, index) => [
        frames.text(`reply ${index}`),
        frames.finish("stop"),
        frames.done,
      ]);
      try {
        fs.writeFileSync(
          path.join(s.ws, "widget.ts"),
          "export function findWidgetSentinel() { return 1; }\n",
          "utf8",
        );
        const champDir = path.join(s.ws, ".champ");
        fs.mkdirSync(champDir, { recursive: true });
        fs.writeFileSync(
          path.join(champDir, "memory.json"),
          JSON.stringify([
            {
              id: "mem-test",
              timestamp: Date.now(),
              userQuery: "remember this",
              assistantSummary: "PINNED_MEMORY_SENTINEL_42",
              sessionId: "manual",
              pinned: true,
            },
          ]),
          "utf8",
        );

        const result = await s.run(["--yes", "hello"]);
        expect(result.code).toBe(0);
        const messages = s.mock.requests[0]?.messages as
          | Array<{ role: string; content: string }>
          | undefined;
        const system = (messages ?? [])
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n");
        expect(system).toContain("findWidgetSentinel");
        expect(system).toContain("PINNED_MEMORY_SENTINEL_42");
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

describe("champ CLI — canonical sessions", () => {
  it(
    "imports a legacy extension JSON session into a JSONL log",
    async () => {
      const s = await scenario(() => [frames.text("unused"), frames.done]);
      try {
        const legacy = path.join(s.ws, "legacy.json");
        fs.writeFileSync(
          legacy,
          JSON.stringify({
            version: 1,
            metadata: { id: "old", mode: "agent" },
            history: [{ role: "user", content: "remember me" }],
          }),
        );

        const result = await s.run(["--import-session", legacy]);
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
          "Imported 1 messages into session legacy-old",
        );
        const log = fs.readFileSync(
          path.join(s.ws, ".champ", "sessions", "legacy-old.jsonl"),
          "utf8",
        );
        expect(log).toContain("remember me");
        expect(s.mock.requests).toHaveLength(0);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );
});

describe("champ CLI — structured JSONL output", () => {
  function events(
    stdout: string,
  ): Array<Record<string, unknown> & { v: number }> {
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const event = JSON.parse(line) as Record<string, unknown> & {
          v: number;
        };
        expect(event.v).toBe(1);
        expect(typeof event.at).toBe("string");
        return event;
      });
  }

  it(
    "emits the full event sequence and no plain stdout in --json mode",
    async () => {
      const s = await scenario((_body, index) => {
        if (index === 0) {
          return [
            frames.toolCall("call_read", "read_file", { path: "hello.txt" }),
            frames.finish("tool_calls"),
            frames.usage(100, 5),
            frames.done,
          ];
        }
        return [
          frames.text("Done."),
          frames.finish("stop"),
          frames.usage(120, 6),
          frames.done,
        ];
      });
      try {
        fs.writeFileSync(path.join(s.ws, "hello.txt"), "hi\n", "utf8");
        const result = await s.run(["--json", "--yes", "read hello.txt"]);

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("champ>");
        expect(result.stderr).toContain("[tool] read_file");

        const parsed = events(result.stdout);
        const types = parsed.map((event) => event.type);
        for (const type of [
          "session.started",
          "message.delta",
          "tool.started",
          "tool.completed",
          "usage",
          "message.completed",
          "agent.status",
          "session.completed",
        ]) {
          expect(types).toContain(type);
        }
        expect(parsed.find((e) => e.type === "tool.started")).toMatchObject({
          id: "call_read",
          name: "read_file",
        });
        expect(parsed.at(-1)).toMatchObject({
          type: "session.completed",
          status: "success",
        });
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "emits approval.required for tools that need consent",
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
          frames.text("Done."),
          frames.finish("stop"),
          frames.usage(120, 6),
          frames.done,
        ];
      });
      try {
        fs.writeFileSync(path.join(s.ws, "hello.txt"), "before\n", "utf8");
        const result = await s.run([
          "--json",
          "--yes",
          "replace before with after in hello.txt",
        ]);
        expect(result.code).toBe(0);
        const parsed = events(result.stdout);
        expect(parsed.some((e) => e.type === "approval.required")).toBe(true);
        expect(parsed.some((e) => e.type === "tool.completed")).toBe(true);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "reports failed provider turns as JSONL events with a non-zero exit",
    async () => {
      const ws = makeWorkspace("cli-jsonl-error");
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
        const result = await runCli(["--json", "-y", "do something"], {
          cwd: ws,
          configPath,
        });
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Request failed: 404");

        const parsed = events(result.stdout);
        expect(parsed.some((e) => e.type === "error")).toBe(true);
        expect(parsed.at(-1)).toMatchObject({
          type: "session.completed",
          status: "failed",
        });
      } finally {
        await new Promise<void>((resolve) => failing.close(() => resolve()));
      }
    },
    TIMEOUT,
  );
});

describe("champ CLI — subprocess RPC", () => {
  function rpcLines(stdout: string): Array<Record<string, unknown>> {
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function response(
    lines: Array<Record<string, unknown>>,
    id: number,
  ): Record<string, unknown> | undefined {
    return lines.find((line) => line.id === id);
  }

  it(
    "speaks only JSON on stdout and reuses the shared agent runtime",
    async () => {
      const s = await scenario((_body, index) => {
        if (index === 0) {
          return [
            frames.toolCall("call_read", "read_file", { path: "hello.txt" }),
            frames.finish("tool_calls"),
            frames.usage(10, 2),
            frames.done,
          ];
        }
        return [
          frames.text("RPC done."),
          frames.finish("stop"),
          frames.usage(12, 3),
          frames.done,
        ];
      });
      try {
        fs.writeFileSync(path.join(s.ws, "hello.txt"), "hi\n", "utf8");
        const requests = [
          { id: 1, method: "get_state" },
          { id: 2, method: "list_tools" },
          { id: 3, method: "prompt", params: { text: "read hello.txt" } },
          { id: 4, method: "unknown_method" },
        ];
        const result = await s.run(["--rpc"], {
          stdin: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
        });

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        const lines = rpcLines(result.stdout);
        expect(lines.length).toBeGreaterThan(0);
        expect(response(lines, 1)).toMatchObject({
          ok: true,
          result: { mode: "agent", protocol: 1 },
        });
        expect(response(lines, 2)).toMatchObject({
          ok: true,
          result: {
            tools: expect.arrayContaining([
              expect.objectContaining({ name: "read_file" }),
            ]),
          },
        });
        expect(lines).toContainEqual({
          method: "tool.completed",
          params: expect.objectContaining({ id: "call_read" }),
        });
        expect(lines).toContainEqual({
          method: "message.delta",
          params: { text: "RPC done." },
        });
        expect(response(lines, 3)).toMatchObject({
          ok: true,
          result: { text: "RPC done.", status: "success" },
        });
        expect(response(lines, 4)).toMatchObject({
          ok: false,
          error: { code: "unknown_method" },
        });
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "changes the active model without restarting the subprocess",
    async () => {
      const s = await scenario(() => [frames.done]);
      try {
        const requests = [
          { id: 1, method: "set_model", params: { model: "second-model" } },
          { id: 2, method: "get_state" },
        ];
        const result = await s.run(["--rpc"], {
          stdin: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
        });

        expect(result.code).toBe(0);
        const lines = rpcLines(result.stdout);
        expect(response(lines, 1)).toMatchObject({
          ok: true,
          result: { model: "second-model" },
        });
        expect(response(lines, 2)).toMatchObject({
          ok: true,
          result: { model: "second-model" },
        });
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "reports provider failures in the prompt response",
    async () => {
      const ws = makeWorkspace("cli-rpc-error");
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
        const requests = [{ id: 1, method: "prompt", params: { text: "x" } }];
        const result = await runCli(["--rpc"], {
          cwd: ws,
          configPath,
          stdin: `${JSON.stringify(requests[0])}\n`,
        });

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        const lines = rpcLines(result.stdout);
        expect(lines).toContainEqual({
          method: "error",
          params: { message: expect.stringContaining("Request failed: 404") },
        });
        expect(response(lines, 1)).toMatchObject({
          ok: true,
          result: {
            status: "failed",
            error: expect.stringContaining("Request failed: 404"),
          },
        });
      } finally {
        await new Promise<void>((resolve) => failing.close(() => resolve()));
      }
    },
    TIMEOUT,
  );

  it(
    "denies an approval-required tool when approve_tool returns false",
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
        fs.writeFileSync(path.join(s.ws, "hello.txt"), "before\n", "utf8");
        const prompt = {
          id: 1,
          method: "prompt",
          params: { text: "edit hello.txt" },
        };
        const denial = {
          id: 2,
          method: "approve_tool",
          params: { approved: false, token: "approval-1" },
        };
        const result = await s.run(["--rpc"], {
          stdin: `${JSON.stringify(prompt)}\n`,
          dialog: [
            {
              match: '"method":"approval.required"',
              stream: "stdout",
              send: `${JSON.stringify(denial)}\n`,
              end: true,
            },
          ],
        });

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        const lines = rpcLines(result.stdout);
        expect(lines).toContainEqual({
          method: "approval.required",
          params: {
            token: "approval-1",
            description: expect.stringContaining("edit_file"),
          },
        });
        expect(response(lines, 2)).toMatchObject({
          ok: true,
          result: { approved: false },
        });
        expect(response(lines, 1)).toMatchObject({
          ok: true,
          result: { status: "success" },
        });
        expect(fs.readFileSync(path.join(s.ws, "hello.txt"), "utf8")).toBe(
          "before\n",
        );
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );
});

describe("champ CLI — team commands (dist/cli.js)", () => {
  function writeTeam(ws: string, name: string, yaml: string): void {
    const dir = path.join(ws, ".champ", "teams");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml.trim() + "\n");
  }

  const basicTeam = `
name: basic
description: Basic two-agent team
execution:
  checkpoints: true
  retries: 0
agents:
  - id: planner
    name: Planner
    role: plans
    systemPrompt: You are the planner.
  - id: coder
    name: Coder
    role: codes
    systemPrompt: You are the coder.
    dependsOn: [planner]
`;

  it(
    "lists teams and recorded runs without making provider calls",
    async () => {
      const s = await scenario(() => [frames.text("unused"), frames.done]);
      try {
        writeTeam(s.ws, "basic", basicTeam);
        const list = await s.run(["team", "list"]);
        expect(list.code).toBe(0);
        expect(list.stdout).toContain("basic");
        expect(s.mock.requests).toHaveLength(0);

        const history = await s.run(["team", "history"]);
        expect(history.code).toBe(0);
        expect(history.stdout).toContain("No team runs recorded");
        expect(s.mock.requests).toHaveLength(0);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "runs a team through the shared provider and records history",
    async () => {
      const s = await scenario(() => [
        frames.text("agent output"),
        frames.finish("stop"),
        frames.usage(10, 5),
        frames.done,
      ]);
      try {
        writeTeam(s.ws, "basic", basicTeam);
        const run = await s.run(["team", "run", "basic", "build the feature"]);
        expect(run.timedOut).toBe(false);
        expect(run.code).toBe(0);
        expect(run.stdout).toContain("[planner] done");
        expect(run.stdout).toContain("[coder] done");
        expect(run.stdout).toMatch(/Team run team-[^\s:]+: completed/);
        expect(s.mock.requests.length).toBeGreaterThanOrEqual(2);

        const history = await s.run(["team", "history"]);
        expect(history.code).toBe(0);
        expect(history.stdout).toContain("completed");
        expect(history.stdout).toContain("IST");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "refuses conflicting file ownership before contacting the provider",
    async () => {
      const s = await scenario(() => [frames.text("unused"), frames.done]);
      try {
        writeTeam(
          s.ws,
          "unsafe",
          `
name: unsafe
description: Conflicting writers
agents:
  - id: a
    name: A
    role: writes
    systemPrompt: A
    tools: [edit_file]
    owns: [src/**]
  - id: b
    name: B
    role: writes
    systemPrompt: B
    tools: [create_file]
    owns: [src/file.ts]
`,
        );
        const result = await s.run(["team", "run", "unsafe", "do it"]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("own overlapping paths");
        expect(s.mock.requests).toHaveLength(0);
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );
});
