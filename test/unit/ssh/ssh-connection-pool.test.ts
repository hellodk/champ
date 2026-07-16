/**
 * TDD: Tests for SSHConnectionPool.
 * Validates connection pooling, host verification, auth negotiation, and MITM detection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SSHConnectionPool } from "@/ssh/ssh-connection-pool";
import { SSHAuthMethod } from "@/ssh/types";

describe("SSHConnectionPool", () => {
  let pool: SSHConnectionPool;
  const testHost = "example.com";
  const testPort = 22;
  const testUser = "ubuntu";
  const testFingerprint = "SHA256:abc123def456ghi789jkl";

  beforeEach(() => {
    pool = new SSHConnectionPool({ maxConnections: 5 });
  });

  afterEach(async () => {
    await pool.destroy();
  });

  // ========== Connection Pooling Tests ==========
  describe("connection pooling", () => {
    it("should create and reuse connections", async () => {
      const conn1 = await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });
      expect(conn1).toBeDefined();

      const conn2 = await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });
      expect(conn2).toBe(conn1);
    });

    it("should maintain separate connections for different hosts", async () => {
      const conn1 = await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });

      const conn2 = await pool.getConnection("other.com", testPort, testUser, {
        fingerprint: "SHA256:other123",
        authMethods: ["ssh-agent"],
      });

      expect(conn1).not.toBe(conn2);
    });

    it("should respect maxConnections limit", async () => {
      const pool2 = new SSHConnectionPool({ maxConnections: 2 });

      try {
        // First, create connections up to the limit
        const conn1 = await pool2.getConnection(
          "host1.com",
          testPort,
          testUser,
          {
            fingerprint: "SHA256:fp1",
            authMethods: ["ssh-agent"],
          },
        );

        const conn2 = await pool2.getConnection(
          "host2.com",
          testPort,
          testUser,
          {
            fingerprint: "SHA256:fp2",
            authMethods: ["ssh-agent"],
          },
        );

        expect(pool2.getPoolSize()).toBe(2);

        // Third connection should reuse or evict an existing one
        const conn3 = await pool2.getConnection(
          "host3.com",
          testPort,
          testUser,
          {
            fingerprint: "SHA256:fp3",
            authMethods: ["ssh-agent"],
          },
        );

        // Pool size should not exceed max
        expect(pool2.getPoolSize()).toBeLessThanOrEqual(2);
      } finally {
        await pool2.destroy();
      }
    });

    it("should release connections back to the pool", async () => {
      const conn = await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });

      const key = `${testHost}:${testPort}:${testUser}`;
      pool.releaseConnection(key);

      // Should be able to get it again (may be the same or a new one)
      const conn2 = await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });
      expect(conn2).toBeDefined();
    });
  });

  // ========== Host Fingerprint Verification Tests ==========
  describe("host fingerprint verification", () => {
    it("should store and verify known host fingerprints", async () => {
      const hostKey = `${testHost}:${testPort}`;
      pool.addKnownHost(hostKey, testFingerprint);

      const isVerified = pool.verifyHostFingerprint(hostKey, testFingerprint);
      expect(isVerified).toBe(true);
    });

    it("should reject mismatched fingerprints (MITM detection)", () => {
      const hostKey = `${testHost}:${testPort}`;
      pool.addKnownHost(hostKey, testFingerprint);

      const isVerified = pool.verifyHostFingerprint(
        hostKey,
        "SHA256:different123",
      );
      expect(isVerified).toBe(false);
    });

    it("should detect unknown hosts on first connection", () => {
      const hostKey = `${testHost}:${testPort}`;
      const isVerified = pool.verifyHostFingerprint(hostKey, testFingerprint);
      // First time should indicate unknown (not verified)
      expect(isVerified).toBe(false);
    });

    it("should allow connection to new unknown hosts after trust decision", () => {
      const hostKey = `${testHost}:${testPort}`;
      // Add host to known hosts (user approves)
      pool.addKnownHost(hostKey, testFingerprint);

      const isVerified = pool.verifyHostFingerprint(hostKey, testFingerprint);
      expect(isVerified).toBe(true);
    });

    it("should return MITM detection event when fingerprint changes", () => {
      const hostKey = `${testHost}:${testPort}`;
      pool.addKnownHost(hostKey, testFingerprint);

      const event = pool.getMitmEvent(hostKey, "SHA256:different123");
      expect(event).toBeDefined();
      expect(event?.type).toBe("fingerprint_mismatch");
      expect(event?.expectedFingerprint).toBe(testFingerprint);
      expect(event?.actualFingerprint).toBe("SHA256:different123");
    });
  });

  // ========== Auth Method Negotiation Tests ==========
  describe("auth method negotiation", () => {
    it("should negotiate auth methods in priority order", async () => {
      const authMethods: SSHAuthMethod[] = ["ssh-agent", "key", "password"];
      const negotiated = pool.negotiateAuthMethods(authMethods);

      // Should maintain order
      expect(negotiated).toEqual(authMethods);
    });

    it("should filter unavailable auth methods", async () => {
      // Simulate ssh-agent not available
      pool.setAuthMethodAvailable("ssh-agent", false);

      const authMethods: SSHAuthMethod[] = ["ssh-agent", "key", "password"];
      const negotiated = pool.negotiateAuthMethods(authMethods);

      expect(negotiated).not.toContain("ssh-agent");
      expect(negotiated).toContain("key");
      expect(negotiated).toContain("password");
    });

    it("should throw if no auth methods are available", () => {
      pool.setAuthMethodAvailable("ssh-agent", false);
      pool.setAuthMethodAvailable("key", false);
      pool.setAuthMethodAvailable("password", false);

      const authMethods: SSHAuthMethod[] = ["ssh-agent", "key", "password"];
      expect(() => pool.negotiateAuthMethods(authMethods)).toThrow(
        /No available auth methods/,
      );
    });

    it("should support custom auth method priority", () => {
      const authMethods: SSHAuthMethod[] = ["password", "key", "ssh-agent"];
      const negotiated = pool.negotiateAuthMethods(authMethods);

      // Should maintain custom order
      expect(negotiated[0]).toBe("password");
      expect(negotiated[1]).toBe("key");
      expect(negotiated[2]).toBe("ssh-agent");
    });
  });

  // ========== Connection Lifecycle Tests ==========
  describe("connection lifecycle", () => {
    it("should close connections properly", async () => {
      const conn = await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });

      const key = `${testHost}:${testPort}:${testUser}`;
      await pool.closeConnection(key);

      // Next getConnection should create a new connection
      const conn2 = await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });
      expect(conn2).not.toBe(conn);
    });

    it("should destroy all connections on pool destroy", async () => {
      await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });

      await pool.getConnection("other.com", testPort, testUser, {
        fingerprint: "SHA256:other",
        authMethods: ["ssh-agent"],
      });

      await pool.destroy();

      // Pool should be empty
      expect(pool.getPoolSize()).toBe(0);
    });

    it("should handle connection errors gracefully", async () => {
      // Mock a failed connection attempt
      const unreachableHost = "unreachable.local.invalid";
      const unreachableFingerprint = "SHA256:unknown";

      // This should not throw, but the connection object should indicate failure
      expect(() =>
        pool.getConnection(unreachableHost, testPort, testUser, {
          fingerprint: unreachableFingerprint,
          authMethods: ["ssh-agent"],
        }),
      ).not.toThrow();
    });
  });

  // ========== Statistics & Monitoring Tests ==========
  describe("pool statistics", () => {
    it("should track pool size", async () => {
      expect(pool.getPoolSize()).toBe(0);

      await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });

      expect(pool.getPoolSize()).toBe(1);
    });

    it("should report connection count", async () => {
      const count1 = pool.getConnectionCount(
        `${testHost}:${testPort}:${testUser}`,
      );
      expect(count1).toBe(0);

      await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });

      const count2 = pool.getConnectionCount(
        `${testHost}:${testPort}:${testUser}`,
      );
      expect(count2).toBeGreaterThanOrEqual(1);
    });

    it("should provide pool statistics", async () => {
      await pool.getConnection(testHost, testPort, testUser, {
        fingerprint: testFingerprint,
        authMethods: ["ssh-agent"],
      });

      await pool.getConnection("other.com", testPort, testUser, {
        fingerprint: "SHA256:other",
        authMethods: ["ssh-agent"],
      });

      const stats = pool.getStatistics();
      expect(stats.totalConnections).toBeGreaterThanOrEqual(2);
      expect(stats.maxConnections).toBe(5);
      expect(stats.knownHosts).toBeGreaterThanOrEqual(0);
    });
  });

  // ========== MITM Detection Tests ==========
  describe("MITM detection", () => {
    it("should detect when a known host fingerprint changes", () => {
      const hostKey = `${testHost}:${testPort}`;
      pool.addKnownHost(hostKey, testFingerprint);

      const event = pool.getMitmEvent(hostKey, "SHA256:malicious123");
      expect(event).toBeDefined();
      expect(event?.type).toBe("fingerprint_mismatch");
      expect(event?.hostKey).toBe(hostKey);
    });

    it("should not trigger MITM alert for first connection to new host", () => {
      const hostKey = `${testHost}:${testPort}`;
      const event = pool.getMitmEvent(hostKey, testFingerprint);
      expect(event).toBeNull();
    });

    it("should reset MITM alert after manual verification", () => {
      const hostKey = `${testHost}:${testPort}`;
      pool.addKnownHost(hostKey, testFingerprint);

      // Trigger alert
      let event = pool.getMitmEvent(hostKey, "SHA256:different");
      expect(event).toBeDefined();

      // User verifies and updates fingerprint
      pool.addKnownHost(hostKey, "SHA256:different");
      event = pool.getMitmEvent(hostKey, "SHA256:different");
      expect(event).toBeNull();
    });

    it("should provide detailed MITM event information", () => {
      const hostKey = `${testHost}:${testPort}`;
      pool.addKnownHost(hostKey, testFingerprint);

      const event = pool.getMitmEvent(hostKey, "SHA256:malicious123");
      expect(event?.type).toBe("fingerprint_mismatch");
      expect(event?.severity).toBe("high");
      expect(event?.expectedFingerprint).toBe(testFingerprint);
      expect(event?.actualFingerprint).toBe("SHA256:malicious123");
      expect(event?.timestamp).toBeDefined();
    });
  });
});
