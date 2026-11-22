/**
 * One-way YAML-to-registry importer (`champ config migrate`).
 *
 * Reads `~/.champ/config.yaml` via `ConfigLoader.parseYaml`, preserves URLs,
 * models, tool flags, context windows, options, and task routing assignments,
 * moves any inline self-hosted `apiKey` into the credential store (never JSON),
 * and warns explicitly about cloud secrets that must be re-entered or kept in
 * SecretStorage / environment variables. Never mutates or deletes the YAML file.
 */
import {
  ConfigLoader,
  isProviderName,
  type ChampConfig,
  type ProviderName,
} from "./config-loader";
import { fallbackEnvVarForId, type CredentialStore } from "./credential-store";
import type { EndpointRegistry } from "./endpoint-registry";
import { catalogEntry, legacySecretIdForProvider } from "./provider-catalog";
import type {
  CredentialRef,
  Endpoint,
  ProviderKind,
  TaskAssignment,
} from "./provider-model";

export interface MigrationResult {
  endpoints: number;
  warnings: string[];
  written: boolean;
}

interface PlannedEndpoint {
  kind: ProviderKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  supportsTools?: boolean;
  contextWindow?: number;
  options?: Record<string, unknown>;
  isDefault: boolean;
  credential: CredentialRef;
}

function sameUrl(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").replace(/\/+$/, "") === (b ?? "").replace(/\/+$/, "");
}

function alreadyImported(
  existing: readonly Endpoint[],
  kind: ProviderKind,
  baseUrl: string | undefined,
): boolean {
  return existing.some(
    (ep) =>
      ep.provider === kind &&
      (sameUrl(ep.baseUrl, baseUrl) ||
        ep.name.toLowerCase() === kind.toLowerCase()),
  );
}

export async function migrateFromYaml(deps: {
  configText: string | null;
  registry: EndpointRegistry;
  credentials: CredentialStore;
  dryRun: boolean;
}): Promise<MigrationResult> {
  if (!deps.configText || !deps.configText.trim()) {
    return { endpoints: 0, warnings: [], written: false };
  }

  let parsed: ChampConfig;
  try {
    parsed = ConfigLoader.parseYaml(deps.configText);
  } catch (err) {
    return {
      endpoints: 0,
      warnings: [
        `Could not parse YAML config: ${err instanceof Error ? err.message : String(err)}`,
      ],
      written: false,
    };
  }

  const providerEntries = parsed.providers ?? {};
  const existing = await deps.registry.list();
  const warnings: string[] = [];
  const planned: PlannedEndpoint[] = [];

  for (const [rawKind, conf] of Object.entries(providerEntries)) {
    if (!conf || !isProviderName(rawKind)) continue;
    const kind = rawKind as ProviderName & ProviderKind;
    const entry = catalogEntry(kind);
    const effectiveBaseUrl = conf.baseUrl ?? entry.defaultBaseUrl;

    if (alreadyImported(existing, kind, effectiveBaseUrl)) {
      continue;
    }

    const legacySecretId = legacySecretIdForProvider(kind);
    let credential: CredentialRef = null;
    if (entry.cloud) {
      credential = { kind: "keyring", id: legacySecretId };
      warnings.push(
        `Cloud provider "${kind}" cannot recover keys from YAML; set its key via \`champ setup\`, export ${fallbackEnvVarForId(legacySecretId)}, or keep VS Code SecretStorage key "${legacySecretId}".`,
      );
    } else if (conf.apiKey) {
      credential = { kind: "keyring", id: legacySecretId };
      const unavailable = deps.credentials.unavailableReason?.();
      if (unavailable) {
        warnings.push(
          `Endpoint "${kind}" has an inline apiKey in YAML, but OS keyring is unavailable (${unavailable}); export ${fallbackEnvVarForId(legacySecretId)} before running champ.`,
        );
      }
    }

    planned.push({
      kind,
      baseUrl: effectiveBaseUrl,
      model: conf.model,
      apiKey: conf.apiKey,
      supportsTools: conf.supportsTools,
      contextWindow: conf.contextWindow,
      options: conf.options as Record<string, unknown> | undefined,
      isDefault: parsed.provider === kind,
      credential,
    });
  }

  if (planned.length === 0) {
    return { endpoints: 0, warnings, written: false };
  }

  if (deps.dryRun) {
    return { endpoints: planned.length, warnings, written: false };
  }

  const createdEndpoints: Array<{ ep: Endpoint; plan: PlannedEndpoint }> = [];
  for (const plan of planned) {
    const ep = await deps.registry.add({
      name: plan.kind,
      provider: plan.kind,
      baseUrl: plan.baseUrl,
      isDefault: plan.isDefault,
      supportsTools: plan.supportsTools,
      contextWindow: plan.contextWindow,
      options: plan.options,
      credential: plan.credential,
      models: plan.model ? [{ id: plan.model }] : [],
    });
    if (plan.apiKey && !deps.credentials.unavailableReason?.()) {
      await deps.registry.setCredential(ep.id, plan.apiKey);
    }
    createdEndpoints.push({ ep, plan });
  }

  const defaultCreated =
    createdEndpoints.find((c) => c.plan.isDefault) ?? createdEndpoints[0];
  if (defaultCreated?.plan.model) {
    await deps.registry.setAssignment(
      "default",
      defaultCreated.ep.id,
      defaultCreated.plan.model,
    );
  }

  const routing = parsed.routing;
  if (routing) {
    const tasks: Array<Exclude<TaskAssignment, "default">> = [
      "coding",
      "chat",
      "completion",
      "embedding",
    ];
    for (const task of tasks) {
      const targetModel = routing[task];
      if (!targetModel) continue;
      const owner =
        createdEndpoints.find((c) => c.plan.model === targetModel) ??
        defaultCreated;
      if (owner) {
        await deps.registry.setAssignment(task, owner.ep.id, targetModel);
      }
    }
  }

  return {
    endpoints: createdEndpoints.length,
    warnings,
    written: true,
  };
}

export interface ScrubSecretsResult {
  scrubbedKeys: string[];
  skippedKeys: string[];
  updatedText: string | null;
  written: boolean;
}

const ENV_PLACEHOLDER_RE = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

function stripProviderApiKeysFromYaml(
  yamlText: string,
  kindsToScrub: ReadonlySet<string>,
): string {
  const lines = yamlText.split(/\r?\n/);
  const eol = yamlText.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];

  let inProviders = false;
  let providersIndent = -1;
  let currentKind: string | null = null;
  let kindIndent = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    const isCommentOrEmpty = !trimmed || trimmed.startsWith("#");
    const indent = line.length - line.trimStart().length;

    if (!isCommentOrEmpty) {
      if (indent === 0 && /^providers\s*:\s*(#.*)?$/.test(trimmed)) {
        inProviders = true;
        providersIndent = 0;
        currentKind = null;
        kindIndent = -1;
      } else if (inProviders && indent <= providersIndent) {
        inProviders = false;
        currentKind = null;
        kindIndent = -1;
      } else if (inProviders) {
        const keyMatch = /^([a-z0-9-]+)\s*:\s*(#.*)?$/i.exec(trimmed);
        if (keyMatch && (currentKind === null || indent <= kindIndent)) {
          currentKind = keyMatch[1];
          kindIndent = indent;
        } else if (
          currentKind &&
          kindsToScrub.has(currentKind) &&
          indent > kindIndent &&
          /^apiKey\s*:/.test(trimmed)
        ) {
          continue;
        }
      }
    }

    out.push(line);
  }

  return out.join(eol);
}

export async function scrubYamlSecrets(deps: {
  configText: string | null;
  registry: EndpointRegistry;
  credentials: CredentialStore;
  dryRun: boolean;
  writeConfigText?: (text: string) => void;
}): Promise<ScrubSecretsResult> {
  if (!deps.configText || !deps.configText.trim()) {
    return {
      scrubbedKeys: [],
      skippedKeys: [],
      updatedText: null,
      written: false,
    };
  }

  let parsed: ChampConfig;
  try {
    parsed = ConfigLoader.parseYaml(deps.configText);
  } catch {
    return {
      scrubbedKeys: [],
      skippedKeys: [],
      updatedText: null,
      written: false,
    };
  }

  const endpoints = await deps.registry.list();
  const providerEntries = parsed.providers ?? {};
  const scrubbedKeys: string[] = [];
  const skippedKeys: string[] = [];
  const kindsToScrub = new Set<string>();
  const unavailable = deps.credentials.unavailableReason?.();

  for (const [rawKind, conf] of Object.entries(providerEntries)) {
    if (!conf || !isProviderName(rawKind) || !conf.apiKey) continue;
    const rawKey = conf.apiKey.trim();
    if (!rawKey || ENV_PLACEHOLDER_RE.test(rawKey)) continue;

    const kind = rawKind as ProviderName & ProviderKind;
    const match =
      endpoints.find(
        (ep) =>
          ep.provider === kind &&
          sameUrl(
            ep.baseUrl,
            conf.baseUrl ?? catalogEntry(kind).defaultBaseUrl,
          ),
      ) ?? endpoints.find((ep) => ep.provider === kind);

    if (!match) {
      skippedKeys.push(
        `providers.${kind}.apiKey (no migrated endpoint in providers.json — run \`champ config migrate\` first)`,
      );
      continue;
    }

    if (match.credential?.kind === "env") {
      scrubbedKeys.push(`providers.${kind}.apiKey`);
      kindsToScrub.add(kind);
      continue;
    }

    if (unavailable) {
      skippedKeys.push(
        `providers.${kind}.apiKey (OS keyring unavailable: ${unavailable})`,
      );
      continue;
    }

    const stored = await deps.credentials.get(match.credential);
    if (!stored) {
      skippedKeys.push(
        `providers.${kind}.apiKey (secret not yet stored in keyring for ${match.id})`,
      );
      continue;
    }

    scrubbedKeys.push(`providers.${kind}.apiKey`);
    kindsToScrub.add(kind);
  }

  if (scrubbedKeys.length === 0) {
    return {
      scrubbedKeys: [],
      skippedKeys,
      updatedText: null,
      written: false,
    };
  }

  const updatedText = stripProviderApiKeysFromYaml(
    deps.configText,
    kindsToScrub,
  );
  if (deps.dryRun) {
    return {
      scrubbedKeys,
      skippedKeys,
      updatedText,
      written: false,
    };
  }

  deps.writeConfigText?.(updatedText);
  return {
    scrubbedKeys,
    skippedKeys,
    updatedText,
    written: Boolean(deps.writeConfigText),
  };
}
