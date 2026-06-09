import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import { ChampServer } from "../champ-server";

// Helper: make an HTTP request and return { status, body }
function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
        ...(body !== undefined
          ? { "Content-Length": Buffer.byteLength(body) }
          : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Use a different port for each test suite to avoid conflicts
const BASE_PORT = 13200;
let portOffset = 0;

describe("ChampServer", () => {
  let server: ChampServer;
  let token: string;
  let port: number;

  // Shared mock handlers — typed without generic args for vitest compat
  const onRunTeam = vi.fn(
    (_teamName: string, _task: string): Promise<{ runId: string }> =>
      Promise.resolve({ runId: "" }),
  );
  const onGetRun = vi.fn(
    (_runId: string): Promise<unknown> => Promise.resolve(null),
  );
  const onListRuns = vi.fn((): Promise<unknown[]> => Promise.resolve([]));
  const onChat = vi.fn(
    (_message: string): Promise<string> => Promise.resolve(""),
  );

  beforeEach(async () => {
    port = BASE_PORT + portOffset++;
    onRunTeam.mockReset();
    onGetRun.mockReset();
    onListRuns.mockReset();
    onChat.mockReset();

    server = new ChampServer({
      port,
      version: "1.6.134",
      onRunTeam,
      onGetRun,
      onListRuns,
      onChat,
    });
    await server.start();
    token = server.getToken();
  });

  afterEach(() => {
    server.stop();
  });

  // ---- Auth ----

  it("rejects requests without Authorization header (401)", async () => {
    const { status, body } = await request(port, "GET", "/health");
    expect(status).toBe(401);
    expect((body as { error: string }).error).toMatch(/Unauthorized/);
  });

  it("rejects requests with wrong token (401)", async () => {
    const { status } = await request(port, "GET", "/health", {
      Authorization: "Bearer wrong-token",
    });
    expect(status).toBe(401);
  });

  it("rejects requests with a token that is a prefix of the real token (401)", async () => {
    // Ensures length check in timingSafeEqual path rejects shorter tokens
    const shortToken = token.slice(0, Math.max(1, token.length - 4));
    const { status } = await request(port, "GET", "/health", {
      Authorization: `Bearer ${shortToken}`,
    });
    expect(status).toBe(401);
  });

  it("accepts requests with the exact correct token (200)", async () => {
    // Confirms timingSafeEqual returns true for the exact match
    const { status } = await request(port, "GET", "/health", {
      Authorization: `Bearer ${token}`,
    });
    expect(status).toBe(200);
  });

  // ---- /health ----

  it("GET /health returns 200 with version and port", async () => {
    const { status, body } = await request(port, "GET", "/health", {
      Authorization: `Bearer ${token}`,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", version: "1.6.134", port });
  });

  // ---- /run-team ----

  it("POST /run-team calls onRunTeam and returns 202 with runId", async () => {
    onRunTeam.mockResolvedValue({ runId: "api-123" });

    const { status, body } = await request(
      port,
      "POST",
      "/run-team",
      { Authorization: `Bearer ${token}` },
      JSON.stringify({ teamName: "my-team", task: "do something" }),
    );

    expect(status).toBe(202);
    expect(body).toMatchObject({ runId: "api-123" });
    expect(onRunTeam).toHaveBeenCalledWith("my-team", "do something");
  });

  it("POST /run-team returns 400 when teamName or task is missing", async () => {
    const { status, body } = await request(
      port,
      "POST",
      "/run-team",
      { Authorization: `Bearer ${token}` },
      JSON.stringify({ teamName: "my-team" }),
    );
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/teamName and task/);
  });

  it("POST /run-team returns 503 when onRunTeam handler is absent", async () => {
    const noHandlerServer = new ChampServer({
      port: port + 100,
      version: "1.0.0",
    });
    await noHandlerServer.start();
    const noHandlerToken = noHandlerServer.getToken();
    try {
      const { status } = await request(
        port + 100,
        "POST",
        "/run-team",
        { Authorization: `Bearer ${noHandlerToken}` },
        JSON.stringify({ teamName: "t", task: "x" }),
      );
      expect(status).toBe(503);
    } finally {
      noHandlerServer.stop();
    }
  });

  // ---- /run/:runId ----

  it("GET /run/:id calls onGetRun and returns 200", async () => {
    onGetRun.mockResolvedValue({ runId: "run-abc", status: "completed" });

    const { status, body } = await request(port, "GET", "/run/run-abc", {
      Authorization: `Bearer ${token}`,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ runId: "run-abc", status: "completed" });
    expect(onGetRun).toHaveBeenCalledWith("run-abc");
  });

  it("GET /run/:id returns 404 when run not found", async () => {
    onGetRun.mockResolvedValue(null);

    const { status, body } = await request(port, "GET", "/run/missing-run", {
      Authorization: `Bearer ${token}`,
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/not found/);
  });

  // ---- /runs ----

  it("GET /runs calls onListRuns and returns list", async () => {
    onListRuns.mockResolvedValue([{ runId: "r1" }, { runId: "r2" }]);

    const { status, body } = await request(port, "GET", "/runs", {
      Authorization: `Bearer ${token}`,
    });
    expect(status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toHaveLength(2);
    expect(onListRuns).toHaveBeenCalled();
  });

  it("GET /runs returns empty array when handler absent", async () => {
    const minServer = new ChampServer({ port: port + 200, version: "1.0.0" });
    await minServer.start();
    const minToken = minServer.getToken();
    try {
      const { status, body } = await request(port + 200, "GET", "/runs", {
        Authorization: `Bearer ${minToken}`,
      });
      expect(status).toBe(200);
      expect((body as { runs: unknown[] }).runs).toEqual([]);
    } finally {
      minServer.stop();
    }
  });

  // ---- /chat ----

  it("POST /chat calls onChat and returns response", async () => {
    onChat.mockResolvedValue("Hello from Champ!");

    const { status, body } = await request(
      port,
      "POST",
      "/chat",
      { Authorization: `Bearer ${token}` },
      JSON.stringify({ message: "Hi there" }),
    );
    expect(status).toBe(200);
    expect((body as { response: string }).response).toBe("Hello from Champ!");
    expect(onChat).toHaveBeenCalledWith("Hi there");
  });

  it("POST /chat returns 400 when message is missing", async () => {
    const { status } = await request(
      port,
      "POST",
      "/chat",
      { Authorization: `Bearer ${token}` },
      JSON.stringify({}),
    );
    expect(status).toBe(400);
  });

  // ---- Unknown endpoint ----

  it("returns 404 for unknown endpoints", async () => {
    const { status, body } = await request(port, "GET", "/not-a-real-route", {
      Authorization: `Bearer ${token}`,
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/Unknown endpoint/);
  });

  // ---- Clean stop ----

  it("server stops cleanly and refuses new connections", async () => {
    server.stop();

    await expect(
      request(port, "GET", "/health", { Authorization: `Bearer ${token}` }),
    ).rejects.toThrow();
  });

  // ---- getPort / getToken ----

  it("getPort returns the configured port", () => {
    expect(server.getPort()).toBe(port);
  });

  it("getToken returns a non-empty token string", () => {
    expect(typeof server.getToken()).toBe("string");
    expect(server.getToken().length).toBeGreaterThan(0);
  });
});
