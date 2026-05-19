/**
 * ChampServer: local HTTP server for CI/CD integration.
 * Listens on localhost:3148 (configurable via CHAMP_SERVER_PORT env var).
 *
 * Endpoints:
 *   GET  /health            — server status and version
 *   POST /run-team          — trigger a team run (returns runId)
 *   GET  /run/:runId        — get team run state
 *   GET  /runs              — list recent runs (last 20)
 *   POST /chat              — send a single chat message, get response
 *
 * Auth: Bearer token stored in ~/.champ/server-token.txt (auto-generated
 * on first start). All requests must include Authorization: Bearer <token>.
 * Requests from localhost without the token are rejected.
 */
import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface ChampServerOptions {
  port?: number;
  onRunTeam?: (teamName: string, task: string) => Promise<{ runId: string }>;
  onGetRun?: (runId: string) => Promise<unknown>;
  onListRuns?: () => Promise<unknown[]>;
  onChat?: (message: string) => Promise<string>;
  version?: string;
}

export class ChampServer {
  private server?: http.Server;
  private token: string = "";
  private readonly tokenPath: string;
  private readonly port: number;

  constructor(private readonly options: ChampServerOptions) {
    this.port =
      options.port ?? parseInt(process.env["CHAMP_SERVER_PORT"] ?? "3148", 10);
    this.tokenPath = path.join(os.homedir(), ".champ", "server-token.txt");
  }

  async start(): Promise<void> {
    this.token = await this.getOrCreateToken();

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
      this.server!.once("error", reject);
    });

    console.log(`Champ server listening on localhost:${this.port}`);
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  getPort(): number {
    return this.port;
  }
  getToken(): string {
    return this.token;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Auth check
    const authHeader = req.headers["authorization"] ?? "";
    if (
      !authHeader.startsWith("Bearer ") ||
      authHeader.slice(7) !== this.token
    ) {
      this.respond(res, 401, {
        error: "Unauthorized. Include Authorization: Bearer <token> header.",
      });
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const method = req.method?.toUpperCase() ?? "GET";

    try {
      if (method === "GET" && url.pathname === "/health") {
        this.respond(res, 200, {
          status: "ok",
          version: this.options.version ?? "unknown",
          port: this.port,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/run-team") {
        const body = await this.readBody(req);
        const { teamName, task } = JSON.parse(body) as {
          teamName?: string;
          task?: string;
        };
        if (!teamName || !task) {
          this.respond(res, 400, {
            error: "Request body must include teamName and task",
          });
          return;
        }
        const result = await this.options.onRunTeam?.(teamName, task);
        if (!result) {
          this.respond(res, 503, { error: "Team runner not available" });
          return;
        }
        this.respond(res, 202, result);
        return;
      }

      const runMatch = url.pathname.match(/^\/run\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const state = await this.options.onGetRun?.(runId);
        if (!state) {
          this.respond(res, 404, { error: `Run ${runId} not found` });
          return;
        }
        this.respond(res, 200, state);
        return;
      }

      if (method === "GET" && url.pathname === "/runs") {
        const runs = (await this.options.onListRuns?.()) ?? [];
        this.respond(res, 200, { runs });
        return;
      }

      if (method === "POST" && url.pathname === "/chat") {
        const body = await this.readBody(req);
        const { message } = JSON.parse(body) as { message?: string };
        if (!message) {
          this.respond(res, 400, {
            error: "Request body must include message",
          });
          return;
        }
        const response =
          (await this.options.onChat?.(message)) ?? "[Chat not available]";
        this.respond(res, 200, { response });
        return;
      }

      this.respond(res, 404, {
        error: `Unknown endpoint: ${method} ${url.pathname}`,
      });
    } catch (err) {
      this.respond(res, 500, {
        error: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  private respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      "X-Champ-Version": this.options.version ?? "unknown",
    });
    res.end(json);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf-8");
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private async getOrCreateToken(): Promise<string> {
    try {
      await fs.promises.mkdir(path.dirname(this.tokenPath), {
        recursive: true,
      });
      try {
        return (await fs.promises.readFile(this.tokenPath, "utf-8")).trim();
      } catch {
        const token = crypto.randomBytes(32).toString("hex");
        await fs.promises.writeFile(this.tokenPath, token, { mode: 0o600 });
        return token;
      }
    } catch {
      return crypto.randomBytes(32).toString("hex");
    }
  }
}
