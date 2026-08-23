/**
 * TDD: GET /metrics endpoint on ChampServer (issue #108).
 * Prometheus text exposition backed by MetricsCollector, protected by the
 * same bearer auth as every other endpoint.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import { ChampServer } from "@/server/champ-server";
import { MetricsCollector } from "@/observability/metrics-collector";

const BASE_PORT = 13500;
let portOffset = 0;

interface RawResponse {
  status: number;
  body: string;
  contentType: string;
}

function rawRequest(
  port: number,
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: res.headers["content-type"] ?? "",
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function metricValue(body: string, name: string): number | undefined {
  const line = body.split("\n").find((l) => l.startsWith(`${name} `));
  if (!line) return undefined;
  return parseFloat(line.slice(name.length + 1));
}

describe("ChampServer GET /metrics", () => {
  let server: ChampServer;
  let token: string;
  let port: number;

  function startWith(
    options: ConstructorParameters<typeof ChampServer>[0],
  ): Promise<void> {
    port = BASE_PORT + portOffset++;
    server = new ChampServer({ port, version: "test", ...options });
    return server.start().then(() => {
      token = server.getToken();
    });
  }

  afterEach(() => {
    server?.stop();
  });

  it("returns 401 without Authorization header", async () => {
    await startWith({ metrics: new MetricsCollector() });
    const res = await rawRequest(port, "/metrics");
    expect(res.status).toBe(401);
  });

  it("returns 401 with a wrong token", async () => {
    await startWith({ metrics: new MetricsCollector() });
    const res = await rawRequest(port, "/metrics", {
      Authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 text/plain exposition with counters when collector wired", async () => {
    const collector = new MetricsCollector();
    collector.recordRequest({
      requestLatency: 10,
      totalLatency: 20,
      inputTokens: 5,
      outputTokens: 3,
    });
    collector.recordRequest({
      requestLatency: 11,
      totalLatency: 21,
      inputTokens: 5,
      outputTokens: 3,
    });
    collector.recordAgentStep({
      agentName: "a",
      startTime: 0,
      endTime: 1,
      durationMs: 1,
      input: "i",
      output: "o",
      success: true,
    });
    collector.recordToolCall({
      toolName: "t",
      startTime: 0,
      durationMs: 1,
      success: true,
      args: {},
    });
    collector.recordFailure("boom");
    collector.recordCompletionAccepted("gpt-x", 10);

    await startWith({ metrics: collector });
    const res = await rawRequest(port, "/metrics", {
      Authorization: `Bearer ${token}`,
    });

    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/plain/);
    expect(res.contentType).toContain("version=0.0.4");

    expect(metricValue(res.body, "champ_requests_total")).toBe(2);
    expect(metricValue(res.body, "champ_agent_steps_total")).toBe(1);
    expect(metricValue(res.body, "champ_tool_calls_total")).toBe(1);
    expect(metricValue(res.body, "champ_failures_total")).toBe(1);
    expect(metricValue(res.body, "champ_completion_acceptances_total")).toBe(1);
  });

  it("reflects cumulative totals after buffer eviction", async () => {
    const collector = new MetricsCollector();
    for (let i = 0; i < 1005; i++) {
      collector.recordFailure(`f-${i}`);
    }
    await startWith({ metrics: collector });
    const res = await rawRequest(port, "/metrics", {
      Authorization: `Bearer ${token}`,
    });
    expect(metricValue(res.body, "champ_failures_total")).toBe(1005);
  });

  it("returns 200 with '# no collector' comment when no collector wired", async () => {
    await startWith({});
    const res = await rawRequest(port, "/metrics", {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("# no collector");
    expect(res.body).not.toMatch(/^champ_/m);
  });

  it("/health still served behind the same auth gate", async () => {
    await startWith({ metrics: new MetricsCollector() });
    const denied = await rawRequest(port, "/health");
    expect(denied.status).toBe(401);

    const ok = await new Promise<{ status: number; parsed: unknown }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString()));
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 0,
                parsed: JSON.parse(body),
              });
            });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.parsed).toMatchObject({ status: "ok" });
  });
});
