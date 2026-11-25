/**
 * Typed, atomic editing of Champ's YAML configuration for headless clients.
 *
 * Secrets are deliberately absent from this key list — credentials stay in
 * the OS keyring / providers.json and are managed by `champ provider`.
 */
import * as fs from "fs/promises";
import * as nodePath from "path";
import * as yaml from "js-yaml";

export interface ConfigKey {
  key: string;
  description: string;
  type: "string" | "boolean" | "number";
  allowed?: readonly string[];
}

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "provider", description: "default provider name", type: "string" },
  {
    key: "provider.baseUrl",
    description: "default endpoint base URL",
    type: "string",
  },
  {
    key: "provider.model",
    description: "default endpoint model",
    type: "string",
  },
  {
    key: "agent.defaultMode",
    description: "agent | ask | manual | plan | composer",
    type: "string",
    allowed: ["agent", "ask", "manual", "plan", "composer"],
  },
  {
    key: "agent.permissionProfile",
    description: "read-only | supervised | autonomous",
    type: "string",
    allowed: ["read-only", "supervised", "autonomous"],
  },
  { key: "agent.yoloMode", description: "auto-approve tools", type: "boolean" },
  {
    key: "agent.promptGuard.enabled",
    description: "block prompt injection",
    type: "boolean",
  },
  {
    key: "indexing.enabled",
    description: "enable the semantic index",
    type: "boolean",
  },
  {
    key: "indexing.embeddingModel",
    description: "embedding model id",
    type: "string",
  },
  {
    key: "routing.mode",
    description: "smart | manual",
    type: "string",
    allowed: ["smart", "manual"],
  },
  {
    key: "telemetry.enabled",
    description: "send telemetry events",
    type: "boolean",
  },
  {
    key: "autocomplete.enabled",
    description: "editor inline completions",
    type: "boolean",
  },
] as const;

export interface ConfigFileOptions {
  configPath: string;
  key: string;
}

export interface ConfigEndpointTarget {
  endpointId?: string;
  endpoint?: { id: string; name?: string; baseUrl?: string; provider?: string };
  baseUrl?: string;
  model?: string;
}

function definition(key: string): ConfigKey {
  const found = CONFIG_KEYS.find((entry) => entry.key === key);
  if (!found) throw new Error(`unknown config key "${key}"`);
  return found;
}

function readPath(doc: unknown, key: string): unknown {
  let value: unknown = doc;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function writePath(doc: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split(".");
  let current = doc;
  for (const part of parts.slice(0, -1)) {
    if (
      !current[part] ||
      typeof current[part] !== "object" ||
      Array.isArray(current[part])
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function parseValue(def: ConfigKey, value: string): unknown {
  const text = value.trim();
  if (def.allowed && !def.allowed.includes(text)) {
    throw new Error(
      `invalid value "${text}" for ${def.key} (expected ${def.allowed.join(" | ")})`,
    );
  }
  if (def.type === "boolean") {
    if (text !== "true" && text !== "false") {
      throw new Error(`invalid boolean "${text}" for ${def.key}`);
    }
    return text === "true";
  }
  if (def.type === "number") {
    const number = Number(text);
    if (!Number.isFinite(number)) {
      throw new Error(`invalid number "${text}" for ${def.key}`);
    }
    return number;
  }
  return text;
}

async function readDocument(
  configPath: string,
  strict = false,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (strict) {
      throw new Error(
        `Cannot read config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {};
  }
  if (!text.trim()) return {};

  try {
    const parsed = yaml.load(text);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("top-level YAML value must be a mapping");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (strict) {
      throw new Error(`Cannot parse config at ${configPath}: ${message}`);
    }
    return {};
  }
}

async function writeDocument(
  configPath: string,
  doc: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(nodePath.dirname(configPath), { recursive: true });
  const temp = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(
    temp,
    yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false }),
    "utf8",
  );
  await fs.rename(temp, configPath);
}

export async function setConfigValue(
  options: ConfigFileOptions & {
    value: string;
    endpoint?: ConfigEndpointTarget;
    onEndpoint?: (key: "baseUrl" | "model", value: string) => Promise<void>;
    onProvider?: (providerName: string) => Promise<void>;
  },
): Promise<string> {
  const def = definition(options.key);
  const value = parseValue(def, options.value);
  // Parse before any side effect: a malformed file must never be replaced and
  // endpoint/registry changes must not outlive a failed write (issue #179).
  const doc = await readDocument(options.configPath, true);
  if (options.key === "provider.baseUrl" || options.key === "provider.model") {
    const field = options.key === "provider.baseUrl" ? "baseUrl" : "model";
    await options.onEndpoint?.(field, String(value));
  }
  if (options.key === "provider") {
    await options.onProvider?.(String(value));
  }
  writePath(doc, options.key, value);
  await writeDocument(options.configPath, doc);
  return `${options.key} = ${String(value)}`;
}

export async function getConfigValue(
  options: ConfigFileOptions & { endpoint?: ConfigEndpointTarget },
): Promise<string> {
  const def = definition(options.key);
  if (options.key === "provider.baseUrl") {
    return (
      options.endpoint?.baseUrl ?? options.endpoint?.endpoint?.baseUrl ?? ""
    );
  }
  if (options.key === "provider.model") {
    return options.endpoint?.model ?? "";
  }
  const value = readPath(await readDocument(options.configPath), def.key);
  return value === undefined || value === null ? "" : String(value);
}

/** Human-readable key list used by `champ config show` and the TUI. */
export function configKeyHelp(): string {
  return CONFIG_KEYS.map((entry) => `${entry.key}\t${entry.description}`).join(
    "\n",
  );
}
