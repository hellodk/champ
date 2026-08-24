import { describe, it, expect } from "vitest";
import { validatePublicHttpUrl } from "@/utils/url-guard";

describe("validatePublicHttpUrl", () => {
  describe("allows public http(s) URLs", () => {
    it("allows https://example.com", () => {
      const result = validatePublicHttpUrl("https://example.com");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.url).toBe("https://example.com");
    });

    it("allows http://example.com:8080/path with explicit port", () => {
      const result = validatePublicHttpUrl("http://example.com:8080/path");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.url).toBe("http://example.com:8080/path");
    });
  });

  describe("rejects non-http schemes", () => {
    it("rejects file:///etc/passwd", () => {
      const result = validatePublicHttpUrl("file:///etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    });

    it("rejects ftp:// URLs", () => {
      const result = validatePublicHttpUrl("ftp://example.com/file.txt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe("rejects loopback and private hostnames", () => {
    it.each([
      "http://localhost",
      "http://127.0.0.1",
      "http://[::1]/",
      "https://sub.localhost",
    ])("rejects %s as loopback", (url) => {
      const result = validatePublicHttpUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.toLowerCase()).toMatch(/loopback|localhost/);
      }
    });
  });

  describe("rejects private and link-local IP literals", () => {
    it.each([
      "http://10.0.0.5",
      "http://192.168.1.10",
      "http://169.254.169.254/",
      "http://172.16.0.1",
      "http://172.31.255.255",
    ])("rejects %s as private/link-local address", (url) => {
      const result = validatePublicHttpUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.toLowerCase()).toMatch(
          /private|link-local|internal/,
        );
      }
    });
  });

  describe("rejects mDNS hostnames", () => {
    it("rejects https://foo.local", () => {
      const result = validatePublicHttpUrl("https://foo.local");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe("reason names the violated rule", () => {
    it("names scheme rule for file:// URLs", () => {
      const result = validatePublicHttpUrl("file:///etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/scheme|http/i);
    });

    it("gives a reason for unparseable URLs", () => {
      const result = validatePublicHttpUrl("not-a-url");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
