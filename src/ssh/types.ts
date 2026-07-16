/**
 * SSH Types and Interfaces
 */

export type SSHAuthMethod = "ssh-agent" | "key" | "password";

export interface SSHConnectionOptions {
  /** Host fingerprint (SHA256 format) for verification */
  fingerprint: string;
  /** Auth methods to try, in priority order */
  authMethods: SSHAuthMethod[];
  /** Optional key file path for key-based auth */
  keyFilePath?: string;
  /** Optional password for password auth (not recommended) */
  password?: string;
  /** Connection timeout in milliseconds */
  timeout?: number;
}

export interface SSHConnection {
  /** Unique identifier for this connection */
  id: string;
  /** Host address */
  host: string;
  /** Port number */
  port: number;
  /** Username */
  user: string;
  /** Whether the connection is active */
  isActive: boolean;
  /** When the connection was created */
  createdAt: Date;
  /** Last time this connection was used */
  lastUsedAt: Date;
  /** Auth method that was successfully used */
  authMethod?: SSHAuthMethod;
}

export interface MitmEvent {
  type: "fingerprint_mismatch";
  hostKey: string;
  expectedFingerprint: string;
  actualFingerprint: string;
  severity: "high" | "critical";
  timestamp: Date;
  description: string;
}

export interface PoolStatistics {
  totalConnections: number;
  activeConnections: number;
  maxConnections: number;
  knownHosts: number;
  averageConnectionAge: number;
}

export interface PoolConfig {
  /** Maximum number of connections to maintain */
  maxConnections?: number;
  /** Connection idle timeout in milliseconds */
  idleTimeout?: number;
  /** Whether to persist known hosts to storage */
  persistKnownHosts?: boolean;
  /** Path to known_hosts file (like ~/.ssh/known_hosts) */
  knownHostsPath?: string;
}
