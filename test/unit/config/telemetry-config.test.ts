import { describe, it, expect } from "vitest";
import { ConfigLoader } from "../../../src/config/config-loader";

describe("TelemetryConfig validation", () => {
  it("accepts valid telemetry config", () => {
    const result = ConfigLoader.validate({
      telemetry: { endpoint: "http://localhost:4318", format: "otlp" },
    });
    expect(result.errors).toHaveLength(0);
    expect(result.config.telemetry?.endpoint).toBe("http://localhost:4318");
  });

  it("rejects invalid format", () => {
    const result = ConfigLoader.validate({
      telemetry: { endpoint: "http://localhost", format: "grpc" as "json" },
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/format/);
  });

  it("rejects non-object telemetry", () => {
    const result = ConfigLoader.validate({ telemetry: "bad" as never });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("merges telemetry with override", () => {
    const base = { telemetry: { endpoint: "http://a", enabled: false } };
    const override = { telemetry: { enabled: true } };
    const merged = ConfigLoader.merge(base as never, override as never);
    expect(merged.telemetry?.enabled).toBe(true);
    expect(merged.telemetry?.endpoint).toBe("http://a");
  });
});
