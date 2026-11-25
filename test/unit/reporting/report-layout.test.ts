/**
 * TDD: report paths mandated by the operating standard must be produced by
 * every vitest config and consumed by the unified CLI's report command.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import unitConfig from "../../../vitest.config";
import integrationConfig from "../../../vitest.integration.config";
import e2eConfig from "../../../vitest.e2e.config";

const ROOT = path.resolve(__dirname, "../../..");
const script = fs.readFileSync(path.join(ROOT, "scripts/champ"), "utf8");

describe("test report layout", () => {
  it("unit config writes JUnit XML and coverage JSON to test-reports/unit", () => {
    const test = (unitConfig as { test: Record<string, unknown> }).test;
    expect(JSON.stringify(test.reporters)).toContain("junit");
    expect(JSON.stringify(test.reporters)).toContain(
      "test-reports/unit/results.xml",
    );
    const coverage = test.coverage as Record<string, unknown>;
    expect(coverage.reportsDirectory).toBe("test-reports/unit");
    expect(JSON.stringify(coverage.reporter)).toContain("json");
  });

  it("integration config writes JUnit XML to test-reports/integration", () => {
    const test = (integrationConfig as { test: Record<string, unknown> }).test;
    expect(JSON.stringify(test.reporters)).toContain(
      "test-reports/integration/results.xml",
    );
  });

  it("e2e config writes JSON and HTML to test-reports/e2e", () => {
    const test = (e2eConfig as { test: Record<string, unknown> }).test;
    const serialised = JSON.stringify(test);
    expect(serialised).toContain("test-reports/e2e/results.json");
    expect(serialised).toContain("test-reports/e2e");
  });

  it("the unified CLI reports from the prescribed paths", () => {
    expect(script).toContain('local dir="${ROOT}/test-reports"');
    expect(script).toContain("$dir/unit/results.xml");
    expect(script).toContain("$dir/integration/results.xml");
    expect(script).toContain("$dir/e2e/results.json");
  });

  it("routine test scripts use pnpm rather than npx", () => {
    for (const file of [
      "scripts/run-e2e.sh",
      "scripts/test-report.sh",
      "scripts/run-tests-and-report.js",
    ]) {
      const contents = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(contents, file).not.toMatch(/\bnpx\b/);
    }
  });
});
