import { describe, it, expect } from "vitest";
import { PiiScanner } from "../../../src/safety/pii-scanner";

const scanner = new PiiScanner();

describe("PiiScanner — credit card", () => {
  it("redacts formatted 16-digit card (dashes)", () => {
    const r = scanner.scan("charge 4111-1111-1111-1111 to the account");
    expect(r.redacted).toContain("[REDACTED:credit_card]");
    expect(r.findings[0].type).toBe("credit_card");
  });

  it("redacts space-separated card", () => {
    const r = scanner.scan("card 4111 1111 1111 1111 expired");
    expect(r.redacted).toContain("[REDACTED:credit_card]");
  });

  it("does NOT redact plain integer literal", () => {
    const r = scanner.scan("const MAX_VALUE = 9007199254740991n");
    expect(r.hasFindings).toBe(false);
  });

  it("does NOT redact 16-digit run without separators", () => {
    const r = scanner.scan("return 1234567890123456;");
    expect(r.hasFindings).toBe(false);
  });

  it("does NOT redact timestamp", () => {
    const r = scanner.scan("ts = 1714183200000");
    expect(r.hasFindings).toBe(false);
  });
});

describe("PiiScanner — phone", () => {
  it("redacts US phone with dashes", () => {
    const r = scanner.scan("call me at 555-867-5309");
    expect(r.redacted).toContain("[REDACTED:phone]");
  });

  it("redacts US phone with parens", () => {
    const r = scanner.scan("ring (555) 867-5309 now");
    expect(r.redacted).toContain("[REDACTED:phone]");
  });

  it("redacts international phone", () => {
    const r = scanner.scan("dial +44 7700 900123");
    expect(r.redacted).toContain("[REDACTED:phone]");
  });

  it("does NOT redact semver", () => {
    const r = scanner.scan("requires version 1.2.3 or higher");
    expect(r.hasFindings).toBe(false);
  });

  it("does NOT redact date", () => {
    const r = scanner.scan("deadline: 2026-04-27");
    expect(r.hasFindings).toBe(false);
  });
});

describe("PiiScanner — email still works", () => {
  it("redacts email", () => {
    const r = scanner.scan("contact admin@example.com please");
    expect(r.redacted).toContain("[REDACTED:email]");
  });
});

describe("PiiScanner — SSN still works", () => {
  it("redacts SSN", () => {
    const r = scanner.scan("SSN: 123-45-6789");
    expect(r.redacted).toContain("[REDACTED:ssn]");
  });
});
