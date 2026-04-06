/**
 * TDD: Tests for SecretScanner.
 * Detects and redacts secrets before sending to LLM.
 */
import { describe, it, expect } from "vitest";
import { SecretScanner } from "@/safety/secret-scanner";

describe("SecretScanner", () => {
  const scanner = new SecretScanner();

  it("should detect AWS access keys", () => {
    const text = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(true);
    expect(result.redacted).toContain("[REDACTED]");
    expect(result.redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("should detect API keys in common formats", () => {
    const text = "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop";
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(true);
    expect(result.redacted).not.toContain("sk-ant-api03");
  });

  it("should detect OpenAI API keys", () => {
    const text = 'api_key = "sk-proj-abcdef123456789"';
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(true);
  });

  it("should detect passwords in env files", () => {
    const text = "DB_PASSWORD=supersecret123\nDB_HOST=localhost";
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(true);
    expect(result.redacted).not.toContain("supersecret123");
    expect(result.redacted).toContain("localhost"); // non-secret preserved
  });

  it("should detect private keys", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...";
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(true);
  });

  it("should detect GitHub tokens", () => {
    const text = "GITHUB_TOKEN=ghp_ABCDEFghijklMNOPqrstuvWXYZ012345";
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(true);
  });

  it("should pass through text without secrets", () => {
    const text = 'const x = 1;\nfunction hello() { return "world"; }';
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(false);
    expect(result.redacted).toBe(text);
  });

  it("should handle multiple secrets in one text", () => {
    const text = "KEY1=sk-ant-api-xxx\nKEY2=ghp_yyy\nNORMAL=hello";
    const result = scanner.scan(text);
    expect(result.hasSecrets).toBe(true);
    expect(result.secretCount).toBeGreaterThanOrEqual(2);
  });
});
