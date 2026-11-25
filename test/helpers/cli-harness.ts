/**
 * Harness for running the headless CLI (`dist/cli.js`) end to end — issue
 * #136.
 *
 * Provides:
 *   buildCli()      — bundle src/cli.ts → dist/cli.js (the `bin` artifact)
 *   startMockOpenAI — a local OpenAI-compatible server speaking SSE, scripted
 *                     per request so tests can drive read → edit → reply turns
 *   writeChampConfig — hermetic legacy config.yaml + canonical providers.json
 *   runCli()        — spawn `node dist/cli.js …` and capture the result
 *
 * Not a test file itself (vitest only collects *.test.ts).
 */
import * as esbuild from "esbuild";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";

export const ROOT = process.cwd();
export const CLI_PATH = path.join(ROOT, "dist", "cli.js");

/** One SSE frame: an object serialized as `data: {json}`, or a raw string. */
export type SseFrame = Record<string, unknown> | string;

/** Build the CLI entry exactly the way `node esbuild.mjs` does. */
export async function buildCli(): Promise<string> {
  // Vitest runs integration files in parallel workers, all calling buildCli().
  // Build to a worker-specific file and rename atomically so a child CLI can
  // never observe a half-written bundle.
  const tempOutfile = path.join(ROOT, "dist", `.cli.${process.pid}.js`);
  await esbuild.build({
    entryPoints: ["src/cli.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: tempOutfile,
    logLevel: "silent",
    sourcemap: false,
    external: ["playwright", "playwright-core", "chromium-bidi"],
    // Keep in sync with esbuild.mjs: yoga-layout-prebuilt needs a global `_a`.
    banner: { js: "#!/usr/bin/env node\nvar _a;" },
    alias: {
      "node-fetch": "./shims/node-fetch.cjs",
      "formdata-node": "./shims/formdata-node/index.cjs",
      "formdata-node/file-from-path":
        "./shims/formdata-node/file-from-path.cjs",
      "abort-controller": "./shims/abort-controller.cjs",
    },
  });
  fs.renameSync(tempOutfile, CLI_PATH);
  // Same as esbuild.mjs: npm sets +x for `bin` installs, so do it locally.
  fs.chmodSync(CLI_PATH, 0o755);
  return CLI_PATH;
}

export interface MockOpenAI {
  /** Base URL to put in config.yaml — includes the `/v1` suffix. */
  baseUrl: string;
  /** Parsed request bodies, in arrival order. */
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}

export type SseResponder = (
  body: Record<string, unknown>,
  index: number,
) => SseFrame[];

/**
 * Start a mock OpenAI-compatible server on an ephemeral port. The responder
 * returns the SSE frames for each chat completion request, in order; every
 * other path 404s (the provider probes /models and falls back gracefully).
 */
export async function startMockOpenAI(
  responder: SseResponder,
): Promise<MockOpenAI> {
  const requests: Record<string, unknown>[] = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = req.url ?? "";
      if (!url.includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        body = {};
      }
      const index = requests.length;
      requests.push(body);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const frame of responder(body, index)) {
        const payload =
          typeof frame === "string" ? frame : JSON.stringify(frame);
        res.write(`data: ${payload}\n\n`);
      }
      res.end();
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

/** SSE frame builders matching what openai-compatible.ts parses. */
export const frames = {
  text: (content: string): SseFrame => ({
    choices: [{ delta: { content }, finish_reason: null }],
  }),
  toolCall: (
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): SseFrame => ({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }),
  finish: (reason: "stop" | "tool_calls"): SseFrame => ({
    choices: [{ delta: {}, finish_reason: reason }],
  }),
  usage: (promptTokens: number, completionTokens: number): SseFrame => ({
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  }),
  done: "[DONE]",
};

/** Credential name used by the harness-generated canonical endpoint. */
export const HARNESS_CREDENTIAL_ENV = "CHAMP_TEST_API_KEY";

const HARNESS_TASKS = [
  "default",
  "coding",
  "chat",
  "completion",
  "embedding",
] as const;

/**
 * Write both configuration sources under a throwaway `CHAMP_HOME`:
 * - legacy `config.yaml` for settings/budget assertions;
 * - canonical `providers.json` so the CLI never falls back to the developer's
 *   real `~/.champ/providers.json`.
 */
export function writeChampConfig(
  dir: string,
  opts: {
    baseUrl: string;
    model?: string;
    supportsTools?: boolean;
    budget?: { maxTokensPerRun?: number; maxUsdPerRun?: number };
  },
): string {
  const configDir = path.join(dir, ".champ");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "config.yaml");
  const model = opts.model ?? "mock-model";
  const providers = {
    version: 1,
    endpoints: [
      {
        id: "ep_harness",
        name: "Harness Mock",
        provider: "openai-compatible",
        baseUrl: opts.baseUrl,
        credential: { kind: "env", name: HARNESS_CREDENTIAL_ENV },
        enabled: true,
        isDefault: true,
        supportsTools: opts.supportsTools ?? true,
        models: [{ id: model }],
      },
    ],
    assignments: Object.fromEntries(
      HARNESS_TASKS.map((task) => [task, { endpointId: "ep_harness", model }]),
    ),
    routingMode: "manual",
  };
  fs.writeFileSync(
    path.join(configDir, "providers.json"),
    `${JSON.stringify(providers, null, 2)}\n`,
    "utf8",
  );
  const lines = [
    "provider: openai-compatible",
    "providers:",
    "  openai-compatible:",
    `    baseUrl: "${opts.baseUrl}"`,
    `    model: "${model}"`,
    "    apiKey: test-key",
    `    supportsTools: ${opts.supportsTools ?? true}`,
  ];
  if (opts.budget) {
    lines.push("agent:", "  budget:");
    if (opts.budget.maxTokensPerRun !== undefined) {
      lines.push(`    maxTokensPerRun: ${opts.budget.maxTokensPerRun}`);
    }
    if (opts.budget.maxUsdPerRun !== undefined) {
      lines.push(`    maxUsdPerRun: ${opts.budget.maxUsdPerRun}`);
    }
  }
  lines.push("");
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCliOptions {
  /** Working directory (= agent workspace root). */
  cwd: string;
  /** Config file passed via CHAMP_CONFIG. Omitted → a non-existent path. */
  configPath?: string;
  env?: Record<string, string>;
  /** Data written to stdin, then stdin is closed (stdin-pipe mode). */
  stdin?: string;
  /**
   * Prompt-driven stdin: send replies when prompts appear instead of writing
   * everything up front. Lets tests script interactive runs (REPL plus
   * approval questions) without a TTY; while steps remain, stdin stays open.
   */
  dialog?: DialogStep[];
  timeoutMs?: number;
}

export interface DialogStep {
  /** Text to wait for on the chosen stream. */
  match: string;
  /** Text written to stdin once `match` has been seen. */
  send: string;
  /** Stream carrying `match` (readline prompts/questions go to stdout). */
  stream?: "stdout" | "stderr";
  /** Close stdin after sending (otherwise when the steps run out). */
  end?: boolean;
}

/** Spawn `node dist/cli.js …` and capture exit code, stdout and stderr. */
export function runCli(args: string[], opts: RunCliOptions): Promise<CliRun> {
  // Isolate the canonical registry/credentials/index from the developer's real
  // ~/.champ. Tests that explicitly set HOME (historically how .champ was
  // redirected) or CHAMP_HOME must keep controlling where .champ lives.
  const explicitHome = opts.env?.CHAMP_HOME ?? opts.env?.HOME;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHAMP_HOME: explicitHome ?? opts.cwd,
    CHAMP_CONFIG: opts.configPath ?? path.join(opts.cwd, "no-such-config.yaml"),
    [HARNESS_CREDENTIAL_ENV]: "test-key",
    ...opts.env,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const dialog = opts.dialog ?? [];
    let step = 0;
    // Per-stream cursor so a step cannot re-match text consumed earlier.
    const cursor = { stdout: 0, stderr: 0 };

    const advance = () => {
      while (step < dialog.length) {
        const current = dialog[step];
        const which = current.stream ?? "stderr";
        const haystack = which === "stdout" ? stdout : stderr;
        const at = haystack.indexOf(current.match, cursor[which]);
        if (at === -1) return;
        cursor[which] = at + current.match.length;
        child.stdin.write(current.send);
        step++;
        if (current.end || step >= dialog.length) child.stdin.end();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      advance();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      advance();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 30_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    if (dialog.length > 0) {
      // Left open until the script drives it to completion.
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    } else if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** Create a throwaway workspace directory (caller removes it on cleanup). */
export function makeWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `champ-${prefix}-`));
}

/** Recursively remove a workspace directory. */
export function removeWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
