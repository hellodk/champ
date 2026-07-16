/**
 * SSHConnectionPool: Manages SSH connections with pooling, host verification,
 * auth negotiation, and MITM detection.
 *
 * Features:
 * - Connection reuse across multiple operations
 * - Host fingerprint verification and storage
 * - Auth method negotiation (ssh-agent, key, password)
 * - MITM detection via fingerprint mismatch alerts
 * - Connection lifecycle management
 */

import { randomUUID } from "crypto";
import {
  SSHConnection,
  SSHConnectionOptions,
  SSHAuthMethod,
  MitmEvent,
  PoolConfig,
  PoolStatistics,
} from "./types";

export class SSHConnectionPool {
  private connections: Map<string, SSHConnection[]> = new Map();
  private knownHosts: Map<string, string> = new Map(); // hostKey -> fingerprint
  private authMethodAvailable: Map<SSHAuthMethod, boolean> = new Map([
    ["ssh-agent", true],
    ["key", true],
    ["password", true],
  ]);
  private config: Required<PoolConfig>;

  constructor(config?: PoolConfig) {
    this.config = {
      maxConnections: config?.maxConnections ?? 10,
      idleTimeout: config?.idleTimeout ?? 300000, // 5 minutes
      persistKnownHosts: config?.persistKnownHosts ?? false,
      knownHostsPath: config?.knownHostsPath ?? "~/.ssh/known_hosts",
    };
  }

  /**
   * Get or create a connection to a remote host.
   * Reuses existing connections from the pool if available.
   */
  async getConnection(
    host: string,
    port: number,
    user: string,
    options: SSHConnectionOptions,
  ): Promise<SSHConnection> {
    const key = this.getConnectionKey(host, port, user);

    // Try to get an existing connection from the pool
    const poolConnections = this.connections.get(key) || [];
    if (poolConnections.length > 0) {
      const existingConn = poolConnections[0];
      existingConn.lastUsedAt = new Date();
      return existingConn;
    }

    // Check pool size limit and evict LRU if necessary
    const activeCount = this.getPoolSize();
    if (activeCount >= this.config.maxConnections) {
      // Evict least recently used connection
      this.evictLRU();
    }

    // Create new connection
    const connection: SSHConnection = {
      id: randomUUID(),
      host,
      port,
      user,
      isActive: true,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      authMethod: this.negotiateAuthMethods(options.authMethods)[0],
    };

    // Store in pool
    if (!this.connections.has(key)) {
      this.connections.set(key, []);
    }
    this.connections.get(key)!.push(connection);

    return connection;
  }

  /**
   * Release a connection back to the pool for reuse.
   */
  releaseConnection(key: string): void {
    const connections = this.connections.get(key);
    if (connections && connections.length > 0) {
      const conn = connections[0];
      conn.lastUsedAt = new Date();
      // Keep connection in pool for reuse
    }
  }

  /**
   * Close a specific connection and remove it from the pool.
   */
  async closeConnection(key: string): Promise<void> {
    const connections = this.connections.get(key);
    if (connections && connections.length > 0) {
      const conn = connections.shift();
      if (conn) {
        conn.isActive = false;
      }
    }
    if (connections && connections.length === 0) {
      this.connections.delete(key);
    }
  }

  /**
   * Destroy the entire connection pool.
   */
  async destroy(): Promise<void> {
    for (const conns of this.connections.values()) {
      for (const conn of conns) {
        conn.isActive = false;
      }
    }
    this.connections.clear();
    this.knownHosts.clear();
  }

  /**
   * Add a host and its fingerprint to the known hosts list.
   */
  addKnownHost(hostKey: string, fingerprint: string): void {
    this.knownHosts.set(hostKey, fingerprint);
  }

  /**
   * Verify that a host's fingerprint matches the known value.
   * Returns false if the host is unknown or fingerprint doesn't match.
   */
  verifyHostFingerprint(hostKey: string, fingerprint: string): boolean {
    const knownFingerprint = this.knownHosts.get(hostKey);
    if (!knownFingerprint) {
      // Host is unknown
      return false;
    }
    return knownFingerprint === fingerprint;
  }

  /**
   * Get MITM event if fingerprint mismatch is detected.
   * Returns null if no MITM is detected (unknown host or matching fingerprint).
   */
  getMitmEvent(hostKey: string, actualFingerprint: string): MitmEvent | null {
    const expectedFingerprint = this.knownHosts.get(hostKey);
    if (!expectedFingerprint) {
      // Unknown host, no MITM alert
      return null;
    }

    if (expectedFingerprint === actualFingerprint) {
      // Fingerprint matches, no alert
      return null;
    }

    // Fingerprint mismatch - potential MITM
    return {
      type: "fingerprint_mismatch",
      hostKey,
      expectedFingerprint,
      actualFingerprint,
      severity: "high",
      timestamp: new Date(),
      description: `Host fingerprint mismatch for ${hostKey}. Expected ${expectedFingerprint}, got ${actualFingerprint}. Possible MITM attack!`,
    };
  }

  /**
   * Negotiate auth methods based on availability and priority.
   * Filters out unavailable methods and returns the remaining list.
   */
  negotiateAuthMethods(requestedMethods: SSHAuthMethod[]): SSHAuthMethod[] {
    const available = requestedMethods.filter(
      (method) => this.authMethodAvailable.get(method) ?? true,
    );

    if (available.length === 0) {
      throw new Error("No available auth methods for SSH connection");
    }

    return available;
  }

  /**
   * Set whether an auth method is available.
   * Used for testing or when certain auth methods are not configured.
   */
  setAuthMethodAvailable(method: SSHAuthMethod, available: boolean): void {
    this.authMethodAvailable.set(method, available);
  }

  /**
   * Get the current size of the connection pool.
   */
  getPoolSize(): number {
    let total = 0;
    for (const conns of this.connections.values()) {
      total += conns.filter((c) => c.isActive).length;
    }
    return total;
  }

  /**
   * Get the number of connections for a specific host:port:user combination.
   */
  getConnectionCount(key: string): number {
    const conns = this.connections.get(key) || [];
    return conns.filter((c) => c.isActive).length;
  }

  /**
   * Get pool statistics.
   */
  getStatistics(): PoolStatistics {
    const totalConnections = this.getTotalConnections();
    const activeConnections = this.getPoolSize();
    const knownHosts = this.knownHosts.size;

    // Calculate average connection age
    let totalAge = 0;
    let connectionCount = 0;
    const now = new Date();

    for (const conns of this.connections.values()) {
      for (const conn of conns) {
        if (conn.isActive) {
          totalAge += now.getTime() - conn.createdAt.getTime();
          connectionCount++;
        }
      }
    }

    const averageConnectionAge =
      connectionCount > 0 ? totalAge / connectionCount : 0;

    return {
      totalConnections,
      activeConnections,
      maxConnections: this.config.maxConnections,
      knownHosts,
      averageConnectionAge,
    };
  }

  /**
   * Private: Get connection key from host, port, and user.
   */
  private getConnectionKey(host: string, port: number, user: string): string {
    return `${host}:${port}:${user}`;
  }

  /**
   * Private: Count total connections (including inactive).
   */
  private getTotalConnections(): number {
    let total = 0;
    for (const conns of this.connections.values()) {
      total += conns.length;
    }
    return total;
  }

  /**
   * Private: Evict the least recently used connection.
   */
  private evictLRU(): void {
    let lruKey: string | null = null;
    let lruIndex = -1;
    let lruTime = new Date(Date.now() + 1000); // Future time to ensure any real time is earlier

    for (const [key, conns] of this.connections.entries()) {
      for (let i = 0; i < conns.length; i++) {
        const conn = conns[i];
        if (conn.isActive && conn.lastUsedAt < lruTime) {
          lruKey = key;
          lruIndex = i;
          lruTime = conn.lastUsedAt;
        }
      }
    }

    if (lruKey !== null && lruIndex >= 0) {
      const conns = this.connections.get(lruKey);
      if (conns && conns[lruIndex]) {
        conns[lruIndex].isActive = false;
        // Remove inactive connection from pool
        conns.splice(lruIndex, 1);
      }
      if (conns && conns.length === 0) {
        this.connections.delete(lruKey);
      }
    }
  }
}
