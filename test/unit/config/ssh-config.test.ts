/**
 * TDD: Tests for SSH Configuration in ConfigLoader.
 *
 * SSH targets allow Champ to connect to remote hosts for operations like
 * file transfer, command execution, and code analysis. Configuration includes:
 * - SSH targets (host, port, username, auth method)
 * - Trusted hosts (certificate pinning, key verification)
 * - Credential management (keys, passwords, certificates)
 *
 * See docs/SSH_CONFIG.md for the schema reference.
 */
import { describe, it, expect } from "vitest";
import { ConfigLoader, type ChampConfig } from "@/config/config-loader";

describe("ConfigLoader — SSH Configuration", () => {
  describe("parseYaml with ssh section", () => {
    it("parses minimal ssh config with a single target", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: production
      host: prod.example.com
      port: 22
      username: deploy
      authMethod: key
      keyPath: ~/.ssh/id_rsa
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.ssh?.targets).toHaveLength(1);
      expect(config.ssh?.targets?.[0]?.name).toBe("production");
      expect(config.ssh?.targets?.[0]?.host).toBe("prod.example.com");
      expect(config.ssh?.targets?.[0]?.port).toBe(22);
      expect(config.ssh?.targets?.[0]?.username).toBe("deploy");
      expect(config.ssh?.targets?.[0]?.authMethod).toBe("key");
      expect(config.ssh?.targets?.[0]?.keyPath).toBe("~/.ssh/id_rsa");
    });

    it("parses ssh config with multiple targets", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: production
      host: prod.example.com
      port: 22
      username: deploy
      authMethod: key
      keyPath: ~/.ssh/id_rsa
    - name: staging
      host: staging.example.com
      port: 22
      username: deploy
      authMethod: password
      password: \${env:STAGING_SSH_PASSWORD}
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.ssh?.targets).toHaveLength(2);
      expect(config.ssh?.targets?.[0]?.name).toBe("production");
      expect(config.ssh?.targets?.[1]?.name).toBe("staging");
      expect(config.ssh?.targets?.[1]?.authMethod).toBe("password");
    });

    it("parses ssh config with trusted hosts", () => {
      const yaml = `
provider: ollama
ssh:
  trustedHosts:
    - host: prod.example.com
      port: 22
      fingerprint: SHA256:abcdef1234567890
      verified: true
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.ssh?.trustedHosts).toHaveLength(1);
      expect(config.ssh?.trustedHosts?.[0]?.host).toBe("prod.example.com");
      expect(config.ssh?.trustedHosts?.[0]?.fingerprint).toBe(
        "SHA256:abcdef1234567890",
      );
      expect(config.ssh?.trustedHosts?.[0]?.verified).toBe(true);
    });

    it("parses ssh config with default settings", () => {
      const yaml = `
provider: ollama
ssh:
  defaults:
    port: 2222
    username: automation
    connectTimeoutMs: 10000
    retryCount: 3
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.ssh?.defaults?.port).toBe(2222);
      expect(config.ssh?.defaults?.username).toBe("automation");
      expect(config.ssh?.defaults?.connectTimeoutMs).toBe(10000);
      expect(config.ssh?.defaults?.retryCount).toBe(3);
    });

    it("rejects ssh target with missing required host field", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: invalid
      port: 22
      username: deploy
      authMethod: key
      keyPath: ~/.ssh/id_rsa
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects ssh target with missing required username field", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: invalid
      host: example.com
      port: 22
      authMethod: key
      keyPath: ~/.ssh/id_rsa
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects ssh target with missing required authMethod field", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: invalid
      host: example.com
      port: 22
      username: deploy
      keyPath: ~/.ssh/id_rsa
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects ssh target with invalid authMethod", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: invalid
      host: example.com
      port: 22
      username: deploy
      authMethod: invalid
      keyPath: ~/.ssh/id_rsa
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects ssh target with key authMethod but no keyPath", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: invalid
      host: example.com
      port: 22
      username: deploy
      authMethod: key
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects ssh target with password authMethod but no password", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: invalid
      host: example.com
      port: 22
      username: deploy
      authMethod: password
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects ssh target with invalid port type", () => {
      const yaml = `
provider: ollama
ssh:
  targets:
    - name: invalid
      host: example.com
      port: "not-a-number"
      username: deploy
      authMethod: key
      keyPath: ~/.ssh/id_rsa
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("parses ssh config without targets as empty", () => {
      const yaml = `
provider: ollama
ssh:
  defaults:
    port: 2222
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.ssh?.targets).toBeUndefined();
      expect(config.ssh?.defaults?.port).toBe(2222);
    });

    it("returns config without ssh section when not specified", () => {
      const yaml = `
provider: ollama
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.ssh).toBeUndefined();
    });
  });

  describe("merge with ssh configuration", () => {
    it("merges ssh targets from workspace config over user config", () => {
      const userConfig: ChampConfig = {
        provider: "ollama",
        ssh: {
          targets: [
            {
              name: "user-prod",
              host: "prod.example.com",
              port: 22,
              username: "deploy",
              authMethod: "key",
              keyPath: "~/.ssh/id_rsa",
            },
          ],
        },
      };

      const workspaceConfig: ChampConfig = {
        ssh: {
          targets: [
            {
              name: "workspace-staging",
              host: "staging.example.com",
              port: 22,
              username: "deploy",
              authMethod: "password",
              password: "secret",
            },
          ],
        },
      };

      const merged = ConfigLoader.merge(userConfig, workspaceConfig);
      expect(merged.ssh?.targets).toHaveLength(2);
      expect(merged.ssh?.targets?.[0]?.name).toBe("user-prod");
      expect(merged.ssh?.targets?.[1]?.name).toBe("workspace-staging");
    });

    it("merges ssh defaults from workspace config over user config", () => {
      const userConfig: ChampConfig = {
        provider: "ollama",
        ssh: {
          defaults: {
            port: 22,
            username: "deploy",
          },
        },
      };

      const workspaceConfig: ChampConfig = {
        ssh: {
          defaults: {
            port: 2222,
            connectTimeoutMs: 5000,
          },
        },
      };

      const merged = ConfigLoader.merge(userConfig, workspaceConfig);
      expect(merged.ssh?.defaults?.port).toBe(2222);
      expect(merged.ssh?.defaults?.username).toBe("deploy");
      expect(merged.ssh?.defaults?.connectTimeoutMs).toBe(5000);
    });

    it("merges ssh trustedHosts from both configs", () => {
      const userConfig: ChampConfig = {
        provider: "ollama",
        ssh: {
          trustedHosts: [
            {
              host: "user.example.com",
              port: 22,
              fingerprint: "SHA256:user123",
              verified: true,
            },
          ],
        },
      };

      const workspaceConfig: ChampConfig = {
        ssh: {
          trustedHosts: [
            {
              host: "workspace.example.com",
              port: 22,
              fingerprint: "SHA256:workspace456",
              verified: true,
            },
          ],
        },
      };

      const merged = ConfigLoader.merge(userConfig, workspaceConfig);
      expect(merged.ssh?.trustedHosts).toHaveLength(2);
    });
  });

  describe("substituteEnv with ssh configuration", () => {
    it("replaces env vars in ssh target password", () => {
      const config: ChampConfig = {
        ssh: {
          targets: [
            {
              name: "staging",
              host: "staging.example.com",
              port: 22,
              username: "deploy",
              authMethod: "password",
              password: "${env:STAGING_PASSWORD}",
            },
          ],
        },
      };

      process.env.STAGING_PASSWORD = "test-password";
      const result = ConfigLoader.substituteEnv(config);
      expect(result.ssh?.targets?.[0]?.password).toBe("test-password");

      delete process.env.STAGING_PASSWORD;
    });

    it("leaves unset env vars in ssh target password as placeholder", () => {
      const config: ChampConfig = {
        ssh: {
          targets: [
            {
              name: "staging",
              host: "staging.example.com",
              port: 22,
              username: "deploy",
              authMethod: "password",
              password: "${env:UNSET_PASSWORD}",
            },
          ],
        },
      };

      const result = ConfigLoader.substituteEnv(config);
      expect(result.ssh?.targets?.[0]?.password).toBe("${env:UNSET_PASSWORD}");
    });
  });
});
