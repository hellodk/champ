import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnalyticsExporter } from "../../../src/telemetry/analytics-exporter";
import type { TelemetryConfig } from "../../../src/config/config-loader";
import type { TelemetryEvent } from "../../../src/telemetry/analytics-exporter";

const baseCfg: TelemetryConfig = {
  endpoint: "http://localhost:4318/v1/traces",
  format: "json",
  bufferMaxEvents: 10,
  bufferMaxBytes: 100_000,
  timeoutMs: 1000,
};

const sampleEvent: TelemetryEvent = {
  runId: "r1",
  timestamp: "2026-04-22T00:00:00.000Z",
  userId: "user-abc",
  sessionId: "sess-1",
  workspaceId: "ws-abc",
  extensionVersion: "1.5.0",
  report: {
    runId: "r1",
    startTime: 0,
    totalDurationMs: 100,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    success: true,
    agents: [],
  },
};

describe("AnalyticsExporter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts event when endpoint is reachable", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(baseCfg.endpoint);
    exp.dispose();
  });

  it("buffers event when fetch throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent);
    expect(exp.bufferedCount()).toBe(1);
    exp.dispose();
  });

  it("flush sends buffered events and clears buffer on success", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent); // goes to buffer
    await exp.flush(); // retries successfully
    expect(exp.bufferedCount()).toBe(0);
    exp.dispose();
  });

  it("flush keeps events in buffer when endpoint still unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));
    const exp = new AnalyticsExporter(baseCfg, "user-abc", "ws-abc");
    await exp.export(sampleEvent);
    await exp.flush();
    expect(exp.bufferedCount()).toBe(1);
    exp.dispose();
  });

  it("wraps payload in OTLP envelope when format is otlp", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter(
      { ...baseCfg, format: "otlp" },
      "user-abc",
      "ws-abc",
    );
    await exp.export(sampleEvent);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      resourceSpans: unknown[];
    };
    expect(body).toHaveProperty("resourceSpans");
    exp.dispose();
  });

  it("sends custom headers when configured", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const exp = new AnalyticsExporter(
      { ...baseCfg, headers: { Authorization: "Bearer tok" } },
      "user-abc",
      "ws-abc",
    );
    await exp.export(sampleEvent);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok",
    );
    exp.dispose();
  });
});
