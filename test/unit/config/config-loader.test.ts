/**
 * TDD: Tests for ConfigLoader.
 *
 * The ConfigLoader is the single source of truth for AIDev runtime
 * configuration. It reads YAML from .aidev/config.yaml (workspace) and
 * ~/.aidev/config.yaml (user), merges them with workspace winning, and
 * validates against a schema. Secrets are NOT in YAML — they live in
 * VS Code's SecretStorage.
 *
 * See docs/CONFIG.md for the schema reference.
 */
import { describe, it, expect } from "vitest";
import { ConfigLoader, type AidevConfig } from "@/config/config-loader";

describe("ConfigLoader", () => {
  describe("parseYaml", () => {
    it("parses a minimal valid config", () => {
      const yaml = `
provider: ollama
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.provider).toBe("ollama");
      expect(config.providers?.ollama?.model).toBe("llama3.1");
      expect(config.providers?.ollama?.baseUrl).toBe("http://localhost:11434");
    });

    it("parses the full schema", () => {
      const yaml = `
provider: llamacpp
providers:
  claude:
    model: claude-sonnet-4-20250514
  llamacpp:
    baseUrl: http://192.168.1.24:21434/v1
    model: Qwen2.5-Coder-7B-Instruct.gguf
autocomplete:
  enabled: true
  debounceMs: 300
  provider: llamacpp
  model: Qwen2.5-Coder-1.5B.gguf
agent:
  yoloMode: false
  defaultMode: agent
  autoFix:
    enabled: true
    maxIterations: 3
indexing:
  enabled: true
  embeddingProvider: ollama
  ignore:
    - node_modules/**
    - dist/**
userRules: |
  Always write tests first.
  Use TypeScript strict mode.
mcp:
  servers:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
`;
      const config = ConfigLoader.parseYaml(yaml);
      expect(config.provider).toBe("llamacpp");
      expect(config.providers?.llamacpp?.baseUrl).toBe(
        "http://192.168.1.24:21434/v1",
      );
      expect(config.autocomplete?.enabled).toBe(true);
      expect(config.autocomplete?.debounceMs).toBe(300);
      expect(config.agent?.defaultMode).toBe("agent");
      expect(config.agent?.autoFix?.maxIterations).toBe(3);
      expect(config.indexing?.ignore).toContain("node_modules/**");
      expect(config.userRules).toContain("Always write tests first");
      expect(config.mcp?.servers).toHaveLength(1);
      expect(config.mcp?.servers?.[0]?.name).toBe("github");
    });

    it("returns an empty config for empty input", () => {
      const config = ConfigLoader.parseYaml("");
      expect(config).toEqual({});
    });

    it("throws on syntactically invalid YAML", () => {
      const yaml = `
provider: [unclosed
  bracket
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects unknown provider names with a clear error", () => {
      const yaml = `provider: nonsense`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow(/provider/i);
    });

    it("rejects invalid types (debounceMs must be number)", () => {
      const yaml = `
provider: ollama
autocomplete:
  debounceMs: "fast"
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow();
    });

    it("rejects invalid agent.defaultMode values", () => {
      const yaml = `
provider: ollama
agent:
  defaultMode: superduper
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow(/defaultmode/i);
    });

    it("never accepts apiKey under providers (secrets must use SecretStorage)", () => {
      const yaml = `
provider: openai
providers:
  openai:
    model: gpt-4o
    apiKey: sk-real-secret
`;
      expect(() => ConfigLoader.parseYaml(yaml)).toThrow(/apikey/i);
    });
  });

  describe("merge", () => {
    it("merges two configs with later one winning", () => {
      const user: AidevConfig = {
        provider: "ollama",
        providers: {
          ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
        },
        autocomplete: { enabled: true, debounceMs: 500 },
      };
      const workspace: AidevConfig = {
        provider: "llamacpp",
        providers: {
          llamacpp: {
            baseUrl: "http://192.168.1.24:21434/v1",
            model: "qwen.gguf",
          },
        },
      };
      const merged = ConfigLoader.merge(user, workspace);
      // Workspace overrides user provider
      expect(merged.provider).toBe("llamacpp");
      // Both providers preserved
      expect(merged.providers?.ollama).toBeDefined();
      expect(merged.providers?.llamacpp).toBeDefined();
      // User-only autocomplete preserved
      expect(merged.autocomplete?.debounceMs).toBe(500);
    });

    it("deep-merges nested provider configs", () => {
      const user: AidevConfig = {
        providers: {
          ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
        },
      };
      const workspace: AidevConfig = {
        providers: { ollama: { model: "qwen2.5-coder" } },
      };
      const merged = ConfigLoader.merge(user, workspace);
      // Model overridden, baseUrl preserved from user
      expect(merged.providers?.ollama?.model).toBe("qwen2.5-coder");
      expect(merged.providers?.ollama?.baseUrl).toBe("http://localhost:11434");
    });

    it("returns a copy — does not mutate inputs", () => {
      const user: AidevConfig = { provider: "ollama" };
      const workspace: AidevConfig = { provider: "claude" };
      const merged = ConfigLoader.merge(user, workspace);
      merged.provider = "openai";
      expect(user.provider).toBe("ollama");
      expect(workspace.provider).toBe("claude");
    });
  });

  describe("substituteEnv", () => {
    it("replaces ${env:VAR} placeholders with process.env values", () => {
      process.env.TEST_AIDEV_VAR = "secretvalue";
      const yaml = `
provider: ollama
providers:
  ollama:
    baseUrl: http://${"${env:TEST_AIDEV_VAR}"}.local:11434
    model: llama3.1
`;
      const config = ConfigLoader.parseYaml(yaml);
      const substituted = ConfigLoader.substituteEnv(config);
      expect(substituted.providers?.ollama?.baseUrl).toBe(
        "http://secretvalue.local:11434",
      );
      delete process.env.TEST_AIDEV_VAR;
    });

    it("leaves non-${env:} strings unchanged", () => {
      const config: AidevConfig = {
        providers: {
          ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
        },
      };
      const substituted = ConfigLoader.substituteEnv(config);
      expect(substituted.providers?.ollama?.baseUrl).toBe(
        "http://localhost:11434",
      );
    });

    it("substitutes inside MCP env blocks too", () => {
      process.env.AIDEV_TEST_TOKEN = "ghp_xxxxxxxx";
      const yaml = `
mcp:
  servers:
    - name: github
      command: npx
      args: ["server"]
      env:
        GITHUB_TOKEN: ${"${env:AIDEV_TEST_TOKEN}"}
`;
      const config = ConfigLoader.parseYaml(yaml);
      const substituted = ConfigLoader.substituteEnv(config);
      expect(substituted.mcp?.servers?.[0]?.env?.GITHUB_TOKEN).toBe(
        "ghp_xxxxxxxx",
      );
      delete process.env.AIDEV_TEST_TOKEN;
    });

    it("leaves missing env vars as-is rather than replacing with empty string", () => {
      delete process.env.DEFINITELY_NOT_SET_AIDEV;
      const yaml = `
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: ${"${env:DEFINITELY_NOT_SET_AIDEV}"}
`;
      const config = ConfigLoader.parseYaml(yaml);
      const substituted = ConfigLoader.substituteEnv(config);
      // Unresolved placeholder remains so the user notices the error
      expect(substituted.providers?.ollama?.model).toContain("env:");
    });
  });

  describe("withDefaults", () => {
    it("fills in built-in defaults for missing fields", () => {
      const config: AidevConfig = { provider: "ollama" };
      const filled = ConfigLoader.withDefaults(config);
      expect(filled.agent?.defaultMode).toBe("agent");
      expect(filled.agent?.yoloMode).toBe(false);
      expect(filled.agent?.autoFix?.enabled).toBe(true);
      expect(filled.agent?.autoFix?.maxIterations).toBe(3);
      expect(filled.autocomplete?.enabled).toBe(true);
      expect(filled.autocomplete?.debounceMs).toBe(300);
      expect(filled.indexing?.enabled).toBe(true);
    });

    it("preserves user-supplied values when filling defaults", () => {
      const config: AidevConfig = {
        provider: "ollama",
        agent: { yoloMode: true, autoFix: { maxIterations: 5 } },
      };
      const filled = ConfigLoader.withDefaults(config);
      expect(filled.agent?.yoloMode).toBe(true);
      expect(filled.agent?.autoFix?.maxIterations).toBe(5);
      // Default for unset field
      expect(filled.agent?.autoFix?.enabled).toBe(true);
    });
  });

  describe("activeProviderConfig", () => {
    it("returns the configured provider's settings", () => {
      const config: AidevConfig = {
        provider: "llamacpp",
        providers: {
          llamacpp: {
            baseUrl: "http://192.168.1.24:21434/v1",
            model: "qwen.gguf",
          },
          ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
        },
      };
      const active = ConfigLoader.activeProviderConfig(config);
      expect(active.name).toBe("llamacpp");
      expect(active.baseUrl).toBe("http://192.168.1.24:21434/v1");
      expect(active.model).toBe("qwen.gguf");
    });

    it("throws when the active provider has no entry under providers:", () => {
      const config: AidevConfig = { provider: "ollama" };
      expect(() => ConfigLoader.activeProviderConfig(config)).toThrow(
        /not configured/i,
      );
    });
  });
});
