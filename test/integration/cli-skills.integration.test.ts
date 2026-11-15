/**
 * Integration tests for CLI skills and project rules (Increment D).
 *
 * Drives the built `dist/cli.js` against a local mock OpenAI-compatible server
 * in hermetic workspaces.
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

function reply(text: string): SseFrame[] {
  return [
    frames.text(text),
    frames.finish("stop"),
    frames.usage(100, 10),
    frames.done,
  ];
}

async function scenario(
  responder: (body: Record<string, unknown>, index: number) => SseFrame[],
) {
  const ws = makeWorkspace("cli-skills-int");
  const mock: MockOpenAI = await startMockOpenAI(responder);
  const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl });
  fixtures.push(ws);
  return {
    ws,
    mock,
    configPath,
    run: (args: string[], opts: Record<string, unknown> = {}) =>
      runCli(args, { cwd: ws, configPath, ...opts }),
    close: async () => {
      await mock.close();
    },
  };
}

function writeFileRel(ws: string, rel: string, content: string): void {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function extractSystemText(req: Record<string, unknown>): string {
  const msgs = (req.messages as Array<{ role: string; content: string }>) ?? [];
  return msgs
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

function extractUserText(req: Record<string, unknown>): string {
  const msgs = (req.messages as Array<{ role: string; content: string }>) ?? [];
  return msgs
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

function extractToolNames(req: Record<string, unknown>): string[] {
  const tools = (req.tools as Array<{ function?: { name?: string } }>) ?? [];
  return tools.map((t) => t.function?.name ?? "").filter(Boolean);
}

beforeAll(async () => {
  await buildCli();
}, TIMEOUT);

afterAll(() => {
  for (const dir of fixtures) removeWorkspace(dir);
  fixtures = [];
});

describe("champ CLI — skills and rules integration", () => {
  it(
    "runs a workspace skill via /name in one-shot mode and sends expanded body",
    async () => {
      const s = await scenario(() => reply("Done."));
      try {
        writeFileRel(
          s.ws,
          ".champ/skills/acme.md",
          "---\nname: acme\ndescription: Acme skill\n---\nACME_BODY: {{userInput}}",
        );
        const res = await s.run(["-y", "/acme check auth"]);
        expect(res.code).toBe(0);
        expect(s.mock.requests).toHaveLength(1);
        expect(extractUserText(s.mock.requests[0])).toContain(
          "ACME_BODY: check auth",
        );
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "workspace skill overrides a built-in skill of the same name",
    async () => {
      const s = await scenario(() => reply("Overridden."));
      try {
        writeFileRel(
          s.ws,
          ".champ/skills/review.md",
          "---\nname: review\ndescription: Custom review\n---\nCUSTOM_REVIEW_OVERRIDE {{userInput}}",
        );
        const res = await s.run(["-y", "/review main.ts"]);
        expect(res.code).toBe(0);
        expect(s.mock.requests).toHaveLength(1);
        expect(extractUserText(s.mock.requests[0])).toContain(
          "CUSTOM_REVIEW_OVERRIDE main.ts",
        );
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "/skills in a scripted REPL lists names + sources and issues zero requests",
    async () => {
      const s = await scenario(() => reply("Should not be called"));
      try {
        writeFileRel(
          s.ws,
          ".champ/skills/acme.md",
          "---\nname: acme\ndescription: Acme custom\n---\nAcme body",
        );
        const res = await s.run(["--repl"], { stdin: "/skills\n/exit\n" });
        expect(res.code).toBe(0);
        expect(s.mock.requests).toHaveLength(0);
        expect(res.stderr).toContain("/acme");
        expect(res.stderr).toContain("workspace");
        expect(res.stderr).toContain("/explain");
        expect(res.stderr).toContain("built-in");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    ".champ/rules/always.md is injected into the outbound system message",
    async () => {
      const s = await scenario(() => reply("OK"));
      try {
        writeFileRel(
          s.ws,
          ".champ/rules/always.md",
          "---\ntype: always\n---\nALWAYS_RULE_MARKER_123",
        );
        const res = await s.run(["-y", "hello"]);
        expect(res.code).toBe(0);
        expect(s.mock.requests).toHaveLength(1);
        expect(extractSystemText(s.mock.requests[0])).toContain(
          "ALWAYS_RULE_MARKER_123",
        );
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    ".champ/rules/scoped.md activates with --file matching glob, not otherwise",
    async () => {
      const s = await scenario(() => reply("OK"));
      try {
        writeFileRel(
          s.ws,
          ".champ/rules/scoped.md",
          "---\ntype: auto-attached\nglob: src/**\n---\nSCOPED_SRC_RULE",
        );
        const hit = await s.run(["-y", "--file", "src/a.ts", "hello"]);
        expect(hit.code).toBe(0);
        expect(extractSystemText(s.mock.requests[0])).toContain(
          "SCOPED_SRC_RULE",
        );

        const miss = await s.run(["-y", "--file", "README.md", "hello"]);
        expect(miss.code).toBe(0);
        expect(extractSystemText(s.mock.requests[1])).not.toContain(
          "SCOPED_SRC_RULE",
        );
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "--no-skills makes a workspace-only skill fail with exit 2 and zero requests",
    async () => {
      const s = await scenario(() => reply("Should not run"));
      try {
        writeFileRel(
          s.ws,
          ".champ/skills/acme.md",
          "---\nname: acme\ndescription: Acme\n---\nBody",
        );
        const res = await s.run(["-y", "--no-skills", "/acme"]);
        expect(res.code).toBe(2);
        expect(s.mock.requests).toHaveLength(0);
        expect(res.stderr).toContain("unknown command /acme");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "--list-skills with an unreachable endpoint exits 0 and prints built-in names",
    async () => {
      const ws = makeWorkspace("cli-list-skills");
      fixtures.push(ws);
      const configPath = writeChampConfig(ws, {
        baseUrl: "http://127.0.0.1:1/v1",
      });
      const res = await runCli(["--list-skills"], { cwd: ws, configPath });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("/explain");
      expect(res.stdout).toContain("/review");
      expect(res.stdout).toContain("/commit");
    },
    TIMEOUT,
  );

  it(
    "REPL: /explain runs in ask mode, then next plain turn still advertises edit_file",
    async () => {
      const s = await scenario(() => reply("Answer"));
      try {
        const res = await s.run(["--repl", "-y"], {
          stdin: "/explain src/a.ts\nnow edit it\n/exit\n",
        });
        expect(res.code).toBe(0);
        expect(s.mock.requests).toHaveLength(2);
        const turn1Tools = extractToolNames(s.mock.requests[0]);
        const turn2Tools = extractToolNames(s.mock.requests[1]);
        expect(turn1Tools).not.toContain("edit_file");
        expect(turn2Tools).toContain("edit_file");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );

  it(
    "REPL: skill with allowedTools: [read_file] scopes turn then restores cleanly",
    async () => {
      const s = await scenario(() => reply("Scoped"));
      try {
        writeFileRel(
          s.ws,
          ".champ/skills/ro.md",
          "---\nname: ro\ndescription: Read only\nallowedTools: [read_file]\n---\nRead {{userInput}}",
        );
        const res = await s.run(["--repl", "-y"], {
          stdin: "/ro foo\n/skills\nnormal turn\n/exit\n",
        });
        expect(res.code).toBe(0);
        expect(s.mock.requests).toHaveLength(2);
        expect(extractToolNames(s.mock.requests[0])).toEqual(["read_file"]);
        expect(extractToolNames(s.mock.requests[1])).toContain("edit_file");
      } finally {
        await s.close();
      }
    },
    TIMEOUT,
  );
});
