import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
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
  type SseFrame,
} from "../helpers/cli-harness";

const TIMEOUT = 30_000;

interface MockOpenAIWithModels {
  baseUrl: string;
  requests: Array<{
    path: string;
    auth?: string;
    body?: Record<string, unknown>;
  }>;
  close: () => Promise<void>;
}

async function startMockWithDiscovery(
  models: string[],
  responder: (body: Record<string, unknown>, index: number) => SseFrame[],
): Promise<MockOpenAIWithModels> {
  const requests: MockOpenAIWithModels["requests"] = [];
  let chatIdx = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const reqPath = req.url ?? "";
      const auth = req.headers.authorization;
      if (reqPath.endsWith("/models")) {
        requests.push({ path: reqPath, auth });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      if (reqPath.includes("/chat/completions")) {
        const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
        requests.push({ path: reqPath, auth, body: parsed });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const frame of responder(parsed, chatIdx++)) {
          const payload =
            typeof frame === "string" ? frame : JSON.stringify(frame);
          res.write(`data: ${payload}\n\n`);
        }
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const fixtures: string[] = [];

function createHomeAndWs(): { home: string; ws: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-home-"));
  const ws = makeWorkspace("cli-reg");
  fixtures.push(home, ws);
  return { home, ws };
}

beforeAll(async () => {
  await buildCli();
}, TIMEOUT);

afterAll(() => {
  for (const dir of fixtures.splice(0)) {
    removeWorkspace(dir);
  }
});

describe("champ CLI provider registry integration", () => {
  it(
    "scripted `champ setup` discovers a model and saves it, and a later one-shot uses it",
    async () => {
      const { home, ws } = createHomeAndWs();
      const mock = await startMockWithDiscovery(["qwen2.5-coder"], () => [
        frames.text("registry ok"),
        frames.finish("stop"),
        frames.done,
      ]);

      try {
        const setupRes = await runCli(["setup"], {
          cwd: ws,
          env: { HOME: home },
          dialog: [
            { match: "Select [1-7]:", send: "7\n" },
            { match: "Base URL", send: `${mock.baseUrl}\n` },
            { match: "Endpoint name", send: "Local Mock\n" },
            { match: "Make default?", send: "y\n", end: true },
          ],
        });

        expect(setupRes.timedOut).toBe(false);
        expect(setupRes.code).toBe(0);
        expect(fs.existsSync(path.join(home, ".champ", "providers.json"))).toBe(
          true,
        );

        const turnRes = await runCli(["-y", "hi"], {
          cwd: ws,
          env: { HOME: home },
        });
        expect(turnRes.code).toBe(0);
        expect(turnRes.stdout).toContain("registry ok");
        const chatReq = mock.requests.find((r) =>
          r.path.includes("/chat/completions"),
        );
        expect(chatReq?.body?.model).toBe("qwen2.5-coder");
      } finally {
        await mock.close();
      }
    },
    TIMEOUT,
  );

  it(
    '`champ -y "hi"` with no registry file behaves as before (legacy YAML path)',
    async () => {
      const { home, ws } = createHomeAndWs();
      const mock = await startMockOpenAI(() => [
        frames.text("legacy ok"),
        frames.finish("stop"),
        frames.done,
      ]);
      const configPath = writeChampConfig(ws, { baseUrl: mock.baseUrl });

      try {
        const res = await runCli(["-y", "hi"], {
          cwd: ws,
          configPath,
          env: { HOME: home },
        });
        expect(res.code).toBe(0);
        expect(res.stdout).toContain("legacy ok");
        expect(fs.existsSync(path.join(home, ".champ", "providers.json"))).toBe(
          false,
        );
      } finally {
        await mock.close();
      }
    },
    TIMEOUT,
  );

  it(
    "CLI flags override a stored registry endpoint",
    async () => {
      const { home, ws } = createHomeAndWs();
      const regMock = await startMockOpenAI(() => [
        frames.text("from registry"),
        frames.finish("stop"),
        frames.done,
      ]);
      const flagMock = await startMockOpenAI(() => [
        frames.text("from flags"),
        frames.finish("stop"),
        frames.done,
      ]);

      fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".champ", "providers.json"),
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              id: "ep_reg",
              name: "Stored",
              provider: "openai-compatible",
              baseUrl: regMock.baseUrl,
              credential: null,
              enabled: true,
              isDefault: true,
              models: [{ id: "stored-model" }],
            },
          ],
          assignments: {
            default: { endpointId: "ep_reg", model: "stored-model" },
          },
          routingMode: "auto",
        }),
        "utf8",
      );

      try {
        const res = await runCli(
          [
            "-y",
            "--provider",
            "openai-compatible",
            "--base-url",
            flagMock.baseUrl,
            "--model",
            "flag-model",
            "hi",
          ],
          { cwd: ws, env: { HOME: home } },
        );
        expect(res.code).toBe(0);
        expect(res.stdout).toContain("from flags");
        expect(regMock.requests).toHaveLength(0);
        expect(flagMock.requests[0]?.model).toBe("flag-model");
      } finally {
        await regMock.close();
        await flagMock.close();
      }
    },
    TIMEOUT,
  );

  it(
    "workspace provider.json selects an endpoint and ignores embedded keys",
    async () => {
      const { home, ws } = createHomeAndWs();
      const defaultMock = await startMockOpenAI(() => [
        frames.text("default"),
        frames.finish("stop"),
        frames.done,
      ]);
      const wsMock = await startMockOpenAI(() => [
        frames.text("workspace"),
        frames.finish("stop"),
        frames.done,
      ]);

      fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".champ", "providers.json"),
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              id: "ep_def",
              name: "Default",
              provider: "openai-compatible",
              baseUrl: defaultMock.baseUrl,
              credential: null,
              enabled: true,
              isDefault: true,
              models: [{ id: "m-def" }],
            },
            {
              id: "ep_ws",
              name: "Workspace Target",
              provider: "openai-compatible",
              baseUrl: wsMock.baseUrl,
              credential: null,
              enabled: true,
              isDefault: false,
              models: [{ id: "m-ws" }],
            },
          ],
          assignments: {},
          routingMode: "auto",
        }),
        "utf8",
      );

      fs.mkdirSync(path.join(ws, ".champ"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, ".champ", "provider.json"),
        JSON.stringify({
          endpoint: "ep_ws",
          model: "m-ws-picked",
          apiKey: "evil-key-must-be-ignored",
        }),
        "utf8",
      );

      try {
        const res = await runCli(["-y", "hi"], {
          cwd: ws,
          env: { HOME: home },
        });
        expect(res.code).toBe(0);
        expect(res.stdout).toContain("workspace");
        expect(defaultMock.requests).toHaveLength(0);
        expect(wsMock.requests[0]?.model).toBe("m-ws-picked");
      } finally {
        await defaultMock.close();
        await wsMock.close();
      }
    },
    TIMEOUT,
  );

  it(
    "--list-skills, --no-skills, and /explain mode+tool restore still work with a registry present",
    async () => {
      const { home, ws } = createHomeAndWs();
      const mock = await startMockOpenAI((_body, index) => {
        if (index === 0) {
          return [frames.text("explained"), frames.finish("stop"), frames.done];
        }
        return [frames.text("follow-up"), frames.finish("stop"), frames.done];
      });

      fs.mkdirSync(path.join(home, ".champ"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".champ", "providers.json"),
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              id: "ep_reg",
              name: "Mock",
              provider: "openai-compatible",
              baseUrl: mock.baseUrl,
              credential: null,
              enabled: true,
              isDefault: true,
              supportsTools: true,
              models: [{ id: "m1" }],
            },
          ],
          assignments: { default: { endpointId: "ep_reg", model: "m1" } },
          routingMode: "auto",
        }),
        "utf8",
      );

      try {
        const listRes = await runCli(["--list-skills", "--cwd", ws], {
          cwd: ws,
          env: { HOME: home },
        });
        expect(listRes.code).toBe(0);
        expect(listRes.stdout).toContain("explain");

        const noSkillsRes = await runCli(
          ["--list-skills", "--no-skills", "--cwd", ws],
          { cwd: ws, env: { HOME: home } },
        );
        expect(noSkillsRes.code).toBe(0);
        expect(noSkillsRes.stdout).toContain("explain");

        const replRes = await runCli(["--repl", "-y"], {
          cwd: ws,
          env: { HOME: home },
          stdin: "/explain src/a.ts\nhello after\n/exit\n",
        });
        expect(replRes.code).toBe(0);
        // Second request must still have tools available after /explain restored tool scope.
        expect(mock.requests).toHaveLength(2);
        const turn1Tools = (
          (mock.requests[0]?.tools ?? []) as Array<{
            function?: { name?: string };
          }>
        ).map((t) => t.function?.name);
        const turn2Tools = (
          (mock.requests[1]?.tools ?? []) as Array<{
            function?: { name?: string };
          }>
        ).map((t) => t.function?.name);
        expect(turn1Tools).not.toContain("edit_file");
        expect(turn2Tools).toContain("edit_file");
      } finally {
        await mock.close();
      }
    },
    TIMEOUT,
  );
});
