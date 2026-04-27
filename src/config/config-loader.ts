/**
 * ConfigLoader: parse and validate Champ's YAML configuration.
 *
 * Champ reads configuration from two YAML files (workspace overrides user):
 *
 *   ~/.champ/config.yaml          — user-wide defaults (personal)
 *   <workspace>/.champ/config.yaml — project-specific (committed, shared)
 *
 * Both files use the same schema (see docs/CONFIG.md). Secrets like API
 * keys are NOT in YAML — they live in VS Code's SecretStorage and are
 * accessed via the Champ: Set API Key command.
 *
 * Precedence (highest wins):
 *   1. workspace .champ/config.yaml
 *   2. user ~/.champ/config.yaml
 *   3. VS Code champ.* settings (legacy backward-compat)
 *   4. built-in defaults
 *
 * The loader is intentionally pure — no filesystem I/O lives here. The
 * caller (extension.ts) reads file contents and passes strings into
 * parseYaml(). This keeps the loader unit-testable and decouples it
 * from vscode.workspace.fs.
 */
import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type ProviderName =
  | "claude"
  | "openai"
  | "gemini"
  | "ollama"
  | "llamacpp"
  | "vllm"
  | "openai-compatible";

export type AgentModeName = "agent" | "ask" | "manual" | "plan" | "composer";

/**
 * Per-provider settings. Note: apiKey is intentionally absent — secrets
 * must go through SecretStorage. The validator rejects any config that
 * tries to put a key under providers.*.apiKey.
 */
export interface ProviderConfig {
  baseUrl?: string;
  model?: string;
}

export interface AutocompleteConfig {
  enabled?: boolean;
  debounceMs?: number;
  /** Provider name to use for autocomplete (if different from chat). */
  provider?: ProviderName;
  model?: string;
}

export interface AutoFixConfig {
  enabled?: boolean;
  maxIterations?: number;
}

export interface AgentConfig {
  yoloMode?: boolean;
  defaultMode?: AgentModeName;
  autoFix?: AutoFixConfig;
  promptGuard?: {
    /** Set to false to disable prompt injection blocking (e.g. for security research). Default: true. */
    enabled?: boolean;
  };
}

export interface IndexingConfig {
  enabled?: boolean;
  embeddingProvider?: ProviderName;
  embeddingModel?: string;
  ignore?: string[];
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPConfig {
  servers?: MCPServerConfig[];
}

export interface RoutingConfig {
  mode?: "smart" | "manual";
  /** Force a specific model ID for coding tasks. null = auto. */
  coding?: string | null;
  chat?: string | null;
  completion?: string | null;
  embedding?: string | null;
}

export interface TelemetryConfig {
  enabled?: boolean;
  endpoint: string;
  format?: "json" | "otlp";
  userId?: string;
  headers?: Record<string, string>;
  bufferMaxEvents?: number;
  bufferMaxBytes?: number;
  timeoutMs?: number;
}

export interface ChampConfig {
  provider?: ProviderName;
  providers?: Partial<Record<ProviderName, ProviderConfig>>;
  autocomplete?: AutocompleteConfig;
  agent?: AgentConfig;
  indexing?: IndexingConfig;
  userRules?: string;
  mcp?: MCPConfig;
  routing?: RoutingConfig;
  telemetry?: TelemetryConfig;
}

const VALID_PROVIDERS: ProviderName[] = [
  "claude",
  "openai",
  "gemini",
  "ollama",
  "llamacpp",
  "vllm",
  "openai-compatible",
];

const EMBEDDING_PROVIDERS = ["ollama", "openai"] as const;

const VALID_MODES: AgentModeName[] = [
  "agent",
  "ask",
  "manual",
  "plan",
  "composer",
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export class ConfigLoader {
  /**
   * Parse and validate a YAML string. Throws on invalid syntax or
   * schema violations. Empty input returns an empty config.
   */
  static parseYaml(text: string): ChampConfig {
    if (!text || !text.trim()) return {};

    let parsed: unknown;
    try {
      parsed = yaml.load(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid YAML: ${msg}`);
    }

    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config must be a YAML object at the top level");
    }

    const validated = ConfigLoader.validate(parsed as Record<string, unknown>);
    if (validated.errors.length > 0) {
      throw new Error(validated.errors[0]);
    }
    return validated.config;
  }

  /**
   * Validate a parsed config object. Returns an object with `errors`
   * (validation messages) and `config` (the validated config). Use
   * parseYaml() to get a ChampConfig directly (it throws on errors).
   */
  static validate(raw: Record<string, unknown>): {
    errors: string[];
    config: ChampConfig;
  } {
    const errors: string[] = [];
    const result: ChampConfig = {};

    const pushError = (msg: string): void => {
      errors.push(msg);
    };

    // provider
    if ("provider" in raw) {
      const v = raw.provider;
      if (typeof v !== "string") {
        pushError("`provider` must be a string");
      } else if (!VALID_PROVIDERS.includes(v as ProviderName)) {
        pushError(
          `Invalid provider "${v}". Must be one of: ${VALID_PROVIDERS.join(", ")}`,
        );
      } else {
        result.provider = v as ProviderName;
      }
    }

    // providers
    if ("providers" in raw) {
      const providers = raw.providers;
      if (
        typeof providers !== "object" ||
        providers === null ||
        Array.isArray(providers)
      ) {
        pushError("`providers` must be an object");
      } else {
        result.providers = {};
        for (const [name, conf] of Object.entries(
          providers as Record<string, unknown>,
        )) {
          if (!VALID_PROVIDERS.includes(name as ProviderName)) {
            pushError(
              `Unknown provider "${name}" under providers:. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
            );
            continue;
          }
          if (
            typeof conf !== "object" ||
            conf === null ||
            Array.isArray(conf)
          ) {
            pushError(`providers.${name} must be an object`);
            continue;
          }
          const c = conf as Record<string, unknown>;
          if ("apiKey" in c) {
            pushError(
              `providers.${name}.apiKey is not allowed in YAML. ` +
                `Store API keys via the 'Champ: Set API Key' command (SecretStorage).`,
            );
            continue;
          }
          const pc: ProviderConfig = {};
          if ("baseUrl" in c) {
            if (typeof c.baseUrl !== "string") {
              pushError(`providers.${name}.baseUrl must be a string`);
            } else {
              pc.baseUrl = c.baseUrl;
            }
          }
          if ("model" in c) {
            if (typeof c.model !== "string") {
              pushError(`providers.${name}.model must be a string`);
            } else {
              pc.model = c.model;
            }
          }
          result.providers[name as ProviderName] = pc;
        }
      }
    }

    // autocomplete
    if ("autocomplete" in raw) {
      const ac = raw.autocomplete;
      if (typeof ac !== "object" || ac === null || Array.isArray(ac)) {
        pushError("`autocomplete` must be an object");
      } else {
        const a = ac as Record<string, unknown>;
        const out: AutocompleteConfig = {};
        if ("enabled" in a) {
          if (typeof a.enabled !== "boolean") {
            pushError("autocomplete.enabled must be a boolean");
          } else {
            out.enabled = a.enabled;
          }
        }
        if ("debounceMs" in a) {
          if (typeof a.debounceMs !== "number") {
            pushError("autocomplete.debounceMs must be a number");
          } else {
            out.debounceMs = a.debounceMs;
          }
        }
        if ("provider" in a) {
          if (
            typeof a.provider !== "string" ||
            !VALID_PROVIDERS.includes(a.provider as ProviderName)
          ) {
            pushError(
              `autocomplete.provider must be one of: ${VALID_PROVIDERS.join(", ")}`,
            );
          } else {
            out.provider = a.provider as ProviderName;
          }
        }
        if ("model" in a) {
          if (typeof a.model !== "string") {
            pushError("autocomplete.model must be a string");
          } else {
            out.model = a.model;
          }
        }
        result.autocomplete = out;
      }
    }

    // agent
    if ("agent" in raw) {
      const ag = raw.agent;
      if (typeof ag !== "object" || ag === null || Array.isArray(ag)) {
        pushError("`agent` must be an object");
      } else {
        const a = ag as Record<string, unknown>;
        const out: AgentConfig = {};
        if ("yoloMode" in a) {
          if (typeof a.yoloMode !== "boolean") {
            pushError("agent.yoloMode must be a boolean");
          } else {
            out.yoloMode = a.yoloMode;
          }
        }
        if ("defaultMode" in a) {
          if (
            typeof a.defaultMode !== "string" ||
            !VALID_MODES.includes(a.defaultMode as AgentModeName)
          ) {
            pushError(
              `agent.defaultMode must be one of: ${VALID_MODES.join(", ")}`,
            );
          } else {
            out.defaultMode = a.defaultMode as AgentModeName;
          }
        }
        if ("autoFix" in a) {
          const af = a.autoFix;
          if (typeof af !== "object" || af === null || Array.isArray(af)) {
            pushError("agent.autoFix must be an object");
          } else {
            const f = af as Record<string, unknown>;
            const fix: AutoFixConfig = {};
            if ("enabled" in f) {
              if (typeof f.enabled !== "boolean") {
                pushError("agent.autoFix.enabled must be a boolean");
              } else {
                fix.enabled = f.enabled;
              }
            }
            if ("maxIterations" in f) {
              if (typeof f.maxIterations !== "number" || f.maxIterations < 1) {
                pushError("agent.autoFix.maxIterations must be a number >= 1");
              } else {
                fix.maxIterations = f.maxIterations;
              }
            }
            out.autoFix = fix;
          }
        }
        if (
          "promptGuard" in a &&
          a.promptGuard !== null &&
          typeof a.promptGuard === "object"
        ) {
          const pg = a.promptGuard as Record<string, unknown>;
          if ("enabled" in pg && typeof pg.enabled !== "boolean") {
            pushError("agent.promptGuard.enabled must be a boolean");
          } else {
            out.promptGuard = { enabled: pg.enabled !== false };
          }
        }
        result.agent = out;
      }
    }

    // indexing
    if ("indexing" in raw) {
      const ix = raw.indexing;
      if (typeof ix !== "object" || ix === null || Array.isArray(ix)) {
        pushError("`indexing` must be an object");
      } else {
        const i = ix as Record<string, unknown>;
        const out: IndexingConfig = {};
        if ("enabled" in i) {
          if (typeof i.enabled !== "boolean") {
            pushError("indexing.enabled must be a boolean");
          } else {
            out.enabled = i.enabled;
          }
        }
        if ("embeddingProvider" in i) {
          if (
            typeof i.embeddingProvider !== "string" ||
            !(EMBEDDING_PROVIDERS as readonly string[]).includes(
              i.embeddingProvider,
            )
          ) {
            pushError(
              `indexing.embeddingProvider must be one of: ${EMBEDDING_PROVIDERS.join(", ")}`,
            );
          } else {
            out.embeddingProvider = i.embeddingProvider as ProviderName;
          }
        }
        if ("ignore" in i) {
          if (
            !Array.isArray(i.ignore) ||
            i.ignore.some((x) => typeof x !== "string")
          ) {
            pushError("indexing.ignore must be an array of strings");
          } else {
            out.ignore = i.ignore as string[];
          }
        }
        result.indexing = out;
      }
    }

    // userRules
    if ("userRules" in raw) {
      if (typeof raw.userRules !== "string") {
        pushError("`userRules` must be a string");
      } else {
        result.userRules = raw.userRules;
      }
    }

    // mcp
    if ("mcp" in raw) {
      const mc = raw.mcp;
      if (typeof mc !== "object" || mc === null || Array.isArray(mc)) {
        pushError("`mcp` must be an object");
      } else {
        const m = mc as Record<string, unknown>;
        const out: MCPConfig = {};
        if ("servers" in m) {
          if (!Array.isArray(m.servers)) {
            pushError("mcp.servers must be an array");
          } else {
            out.servers = [];
            for (let idx = 0; idx < m.servers.length; idx++) {
              const s = m.servers[idx];
              if (typeof s !== "object" || s === null || Array.isArray(s)) {
                pushError(`mcp.servers[${idx}] must be an object`);
                continue;
              }
              const srv = s as Record<string, unknown>;
              if (typeof srv.name !== "string") {
                pushError(`mcp.servers[${idx}].name must be a string`);
                continue;
              }
              if (typeof srv.command !== "string") {
                pushError(`mcp.servers[${idx}].command must be a string`);
                continue;
              }
              const out2: MCPServerConfig = {
                name: srv.name,
                command: srv.command,
              };
              if ("args" in srv) {
                if (
                  !Array.isArray(srv.args) ||
                  srv.args.some((a) => typeof a !== "string")
                ) {
                  pushError(
                    `mcp.servers[${idx}].args must be an array of strings`,
                  );
                } else {
                  out2.args = srv.args as string[];
                }
              }
              if ("env" in srv) {
                if (
                  typeof srv.env !== "object" ||
                  srv.env === null ||
                  Array.isArray(srv.env)
                ) {
                  pushError(`mcp.servers[${idx}].env must be an object`);
                } else {
                  const env: Record<string, string> = {};
                  for (const [k, v] of Object.entries(srv.env)) {
                    if (typeof v !== "string") {
                      pushError(
                        `mcp.servers[${idx}].env.${k} must be a string`,
                      );
                    } else {
                      env[k] = v;
                    }
                  }
                  out2.env = env;
                }
              }
              out.servers.push(out2);
            }
          }
        }
        result.mcp = out;
      }
    }

    // routing
    if ("routing" in raw) {
      const rt = raw.routing;
      if (typeof rt !== "object" || rt === null || Array.isArray(rt)) {
        pushError("`routing` must be an object");
      } else {
        const r = rt as Record<string, unknown>;
        const out: RoutingConfig = {};
        if ("mode" in r) {
          if (r.mode !== "smart" && r.mode !== "manual") {
            pushError('routing.mode must be "smart" or "manual"');
          } else {
            out.mode = r.mode as "smart" | "manual";
          }
        }
        for (const key of [
          "coding",
          "chat",
          "completion",
          "embedding",
        ] as const) {
          if (key in r) {
            if (r[key] !== null && typeof r[key] !== "string") {
              pushError(`routing.${key} must be a string or null`);
            } else {
              out[key] = r[key] as string | null;
            }
          }
        }
        result.routing = out;
      }
    }

    // telemetry
    if (raw.telemetry !== undefined && raw.telemetry !== null) {
      if (typeof raw.telemetry !== "object" || Array.isArray(raw.telemetry)) {
        errors.push("telemetry must be an object");
      } else {
        const tel = raw.telemetry as Record<string, unknown>;
        if (tel.endpoint !== undefined && typeof tel.endpoint !== "string") {
          errors.push("telemetry.endpoint must be a string");
        }
        if (
          tel.format !== undefined &&
          tel.format !== "json" &&
          tel.format !== "otlp"
        ) {
          errors.push('telemetry.format must be "json" or "otlp"');
        }
        if (
          tel.bufferMaxEvents !== undefined &&
          typeof tel.bufferMaxEvents !== "number"
        ) {
          errors.push("telemetry.bufferMaxEvents must be a number");
        }
        if (
          tel.bufferMaxBytes !== undefined &&
          typeof tel.bufferMaxBytes !== "number"
        ) {
          errors.push("telemetry.bufferMaxBytes must be a number");
        }
        if (tel.timeoutMs !== undefined && typeof tel.timeoutMs !== "number") {
          errors.push("telemetry.timeoutMs must be a number");
        }
        if (errors.length === 0) {
          result.telemetry = raw.telemetry as TelemetryConfig;
        }
      }
    }

    return { errors, config: result };
  }

  /**
   * Deep-merge two configs. The second argument wins on conflicts.
   * Used to layer workspace config over user config.
   */
  static merge(base: ChampConfig, override: ChampConfig): ChampConfig {
    const result: ChampConfig = JSON.parse(JSON.stringify(base));

    if (override.provider !== undefined) result.provider = override.provider;
    if (override.userRules !== undefined) result.userRules = override.userRules;

    if (override.providers) {
      result.providers = result.providers ?? {};
      for (const [name, conf] of Object.entries(override.providers)) {
        if (conf) {
          result.providers[name as ProviderName] = {
            ...result.providers[name as ProviderName],
            ...conf,
          };
        }
      }
    }

    if (override.autocomplete) {
      result.autocomplete = {
        ...result.autocomplete,
        ...override.autocomplete,
      };
    }

    if (override.agent) {
      result.agent = { ...result.agent, ...override.agent };
      if (override.agent.autoFix) {
        result.agent.autoFix = {
          ...result.agent?.autoFix,
          ...override.agent.autoFix,
        };
      }
    }

    if (override.indexing) {
      result.indexing = { ...result.indexing, ...override.indexing };
    }

    if (override.mcp) {
      result.mcp = { ...result.mcp, ...override.mcp };
    }

    if (override.routing) {
      result.routing = { ...result.routing, ...override.routing };
    }

    if (override.telemetry) {
      result.telemetry = { ...result.telemetry, ...override.telemetry };
    }

    return result;
  }

  /**
   * Replace ${env:VAR_NAME} placeholders with values from process.env.
   * Walks the entire config tree, including arrays and nested objects.
   * Unset variables are left as the literal placeholder so the user
   * notices the misconfiguration rather than getting a silent empty
   * string.
   */
  static substituteEnv(config: ChampConfig): ChampConfig {
    const replacer = (input: string): string => {
      return input.replace(
        /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (match, name) => {
          const v = process.env[name];
          return v !== undefined ? v : match;
        },
      );
    };

    const walk = (val: unknown): unknown => {
      if (typeof val === "string") return replacer(val);
      if (Array.isArray(val)) return val.map(walk);
      if (val !== null && typeof val === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
          out[k] = walk(v);
        }
        return out;
      }
      return val;
    };

    return walk(config) as ChampConfig;
  }

  /**
   * Fill in built-in defaults for any unset fields. Always called
   * after merge() so the runtime never sees an undefined required
   * setting.
   */
  static withDefaults(config: ChampConfig): ChampConfig {
    return {
      ...config,
      autocomplete: {
        enabled: true,
        debounceMs: 300,
        ...config.autocomplete,
      },
      agent: {
        yoloMode: false,
        defaultMode: "agent",
        ...config.agent,
        autoFix: {
          enabled: true,
          maxIterations: 3,
          ...config.agent?.autoFix,
        },
      },
      indexing: {
        enabled: true,
        ...config.indexing,
      },
    };
  }

  /**
   * Look up the active provider's settings. Returns name + empty config
   * when the provider has no entry under providers: (e.g. cloud providers
   * that only need an API key and don't require baseUrl/model overrides).
   * Throws only when no active provider is set at all.
   */
  static activeProviderConfig(config: ChampConfig): {
    name: ProviderName;
    baseUrl?: string;
    model?: string;
  } {
    const name = config.provider;
    if (!name) {
      throw new Error("No active provider — set `provider:` in your config");
    }
    const entry = config.providers?.[name] ?? {};
    return { name, baseUrl: entry.baseUrl, model: entry.model };
  }
}
