/**
 * Interactive CLI setup flow (`champ setup`), reusing `runWizard` from
 * `src/config/setup-wizard.ts` and persisting via `EndpointRegistry`.
 */
import * as readline from "readline";
import {
  fallbackEnvVarForId,
  type CredentialWriteStatus,
} from "../config/credential-store";
import type { EndpointRegistry } from "../config/endpoint-registry";
import { discoverModels } from "../config/model-discovery";
import {
  catalogEntry,
  legacySecretIdForProvider,
  PROVIDER_CATALOG,
} from "../config/provider-catalog";
import type {
  CredentialRef,
  DiscoveredModel,
  ProviderKind,
} from "../config/provider-model";
import { runWizard } from "../config/setup-wizard";
import { resilientFetch } from "../providers/http-resilience";
import { buildProbeUrl } from "../utils/probe-url";

export interface SetupPrompts {
  choose(
    list: Array<{ label: string; value: string }>,
  ): Promise<string | undefined>;
  input(label: string, initial?: string): Promise<string | undefined>;
  secret(label: string): Promise<string | undefined>;
  confirm(label: string, initial?: boolean): Promise<boolean>;
  pickModel(models: DiscoveredModel[]): Promise<string | undefined>;
}

export interface RunSetupDeps {
  registry: EndpointRegistry;
  prompts: SetupPrompts;
  writeLine: (line: string) => void;
  probeFetch?: typeof fetch;
  discover?: typeof discoverModels;
  now?: () => string;
}

export interface RunSetupResult {
  saved: boolean;
  endpointId?: string;
}

export async function runSetup(deps: RunSetupDeps): Promise<RunSetupResult> {
  const fetchFn = deps.probeFetch ?? fetch;
  const discoverFn = deps.discover ?? discoverModels;
  const nowFn = deps.now ?? (() => new Date().toISOString());

  let capturedKey: string | undefined;
  let userLeftBlankClaudeUrl = false;
  let lastDiscovered: DiscoveredModel[] = [];
  let userCancelledModelPick = false;

  const outcome = await runWizard({
    providers: PROVIDER_CATALOG.map((entry) => ({
      id: entry.kind,
      cloud: entry.cloud,
    })),
    pickProvider: async () =>
      deps.prompts.choose(
        PROVIDER_CATALOG.map((entry) => ({
          label: entry.label,
          value: entry.kind,
        })),
      ),
    inputBaseUrl: async (providerId) => {
      const entry = catalogEntry(providerId as ProviderKind);
      const initial = entry.defaultBaseUrl ?? "";
      const entered = await deps.prompts.input("Base URL", initial);
      if (entered === undefined) return undefined;
      const trimmed = entered.trim();
      if (!trimmed) {
        if (entry.kind === "claude") {
          userLeftBlankClaudeUrl = true;
          return "https://api.anthropic.com/v1";
        }
        return entry.defaultBaseUrl;
      }
      return trimmed;
    },
    probeEndpoint: async (providerId, baseUrl) => {
      const entry = catalogEntry(providerId as ProviderKind);
      if (entry.discovery === "none") {
        return capturedKey ? { status: 200 } : { status: 401 };
      }
      try {
        const res = await resilientFetch(
          buildProbeUrl(baseUrl, providerId),
          { method: "GET" },
          { timeoutMs: 5_000, maxRetries: 0 },
          fetchFn,
        );
        return { status: res.status };
      } catch {
        return { status: undefined, ok: false };
      }
    },
    hasStoredApiKey: async () => Boolean(capturedKey),
    promptForApiKey: async (providerId) =>
      deps.prompts.secret(
        `API key for ${providerId} (stored in OS keyring/env, never in JSON)`,
      ),
    storeKey: async (_providerId, apiKey) => {
      capturedKey = apiKey;
    },
    fetchModels: async (providerId, baseUrl) => {
      const kind = providerId as ProviderKind;
      lastDiscovered = await discoverFn(
        {
          id: "ep_probe",
          name: providerId,
          provider: kind,
          baseUrl,
          credential: null,
          enabled: true,
          isDefault: false,
          models: [],
        },
        capturedKey,
        { fetch: fetchFn, now: nowFn },
      );
      return lastDiscovered.map((m) => m.id);
    },
    pickModel: async () => {
      const picked = await deps.prompts.pickModel(lastDiscovered);
      if (!picked) {
        userCancelledModelPick = true;
      }
      return picked;
    },
  });

  if (outcome.status === "cancelled" || userCancelledModelPick) {
    return { saved: false };
  }

  const kind = outcome.providerId as ProviderKind;
  const entry = catalogEntry(kind);
  let chosenModel = outcome.model;

  if (!chosenModel) {
    deps.writeLine(
      "Warning: could not discover models automatically; enter a model name manually.",
    );
    const manual = await deps.prompts.input("Model name");
    if (manual === undefined || !manual.trim()) {
      return { saved: false };
    }
    chosenModel = manual.trim();
  }

  const existing = await deps.registry.list();
  const endpointName = await deps.prompts.input("Endpoint name", entry.label);
  if (endpointName === undefined || !endpointName.trim()) {
    return { saved: false };
  }

  const makeDefault = await deps.prompts.confirm(
    "Make default?",
    existing.length === 0,
  );

  const keyringUnavailable = deps.registry.credentialsUnavailableReason?.();
  let explicitCredential: CredentialRef | undefined;
  let useEnvReference = false;

  if (keyringUnavailable && (capturedKey || entry.auth === "required")) {
    const suggestedEnvVar = fallbackEnvVarForId(
      legacySecretIdForProvider(kind),
    );
    const preferEnv = await deps.prompts.confirm(
      `OS keyring unavailable (${keyringUnavailable}). Store an explicit environment variable reference (${suggestedEnvVar}) instead?`,
      true,
    );
    if (preferEnv) {
      const enteredEnv = await deps.prompts.input(
        "Environment variable name",
        suggestedEnvVar,
      );
      const envName = (enteredEnv ?? "").trim() || suggestedEnvVar;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        explicitCredential = { kind: "env", name: envName };
        useEnvReference = true;
      } else {
        deps.writeLine(
          `Warning: invalid environment variable name "${envName}"; falling back to process-only env.`,
        );
      }
    }
  }

  const savedEndpoint = await deps.registry.add({
    name: endpointName.trim(),
    provider: kind,
    baseUrl: userLeftBlankClaudeUrl ? undefined : outcome.baseUrl,
    isDefault: makeDefault,
    ...(explicitCredential !== undefined
      ? { credential: explicitCredential }
      : {}),
    models: lastDiscovered.length > 0 ? lastDiscovered : [{ id: chosenModel }],
  });

  let credStatus: CredentialWriteStatus | undefined;
  if (capturedKey) {
    credStatus = await deps.registry.setCredential(
      savedEndpoint.id,
      capturedKey,
    );
  }

  if (savedEndpoint.isDefault) {
    await deps.registry.setAssignment("default", savedEndpoint.id, chosenModel);
  }

  deps.writeLine(
    `Saved endpoint ${savedEndpoint.id} (${savedEndpoint.name}: ${savedEndpoint.provider} -> ${savedEndpoint.baseUrl ?? "default"}, model ${chosenModel})`,
  );

  if (useEnvReference && explicitCredential?.kind === "env") {
    deps.writeLine(
      `Credential configured as env reference ${explicitCredential.name} (NOT written to disk — add \`export ${explicitCredential.name}=...\` to your shell profile).`,
    );
  } else if (credStatus) {
    if (credStatus.persisted) {
      deps.writeLine(
        `Credential persisted in ${credStatus.storage} (ref: ${savedEndpoint.id}).`,
      );
    } else {
      deps.writeLine(
        `Warning: credential was NOT persisted (${credStatus.reason ?? "OS keyring unavailable"}); active for this process only. Export ${credStatus.envVar ?? "the API key"} in your shell before next run.`,
      );
    }
  }

  return { saved: true, endpointId: savedEndpoint.id };
}

function askLine(question: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let settled = false;
    rl.on("SIGINT", () => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(undefined);
      }
    });
    rl.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
    rl.question(question, (answer) => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(answer);
      }
    });
  });
}

function askSecret(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return askLine(`${label}: `);
  }
  return new Promise((resolve) => {
    process.stderr.write(`${label}: `);
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";

    const finish = (result: string | undefined) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
      resolve(result);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          finish(undefined);
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish(buf.trim() || undefined);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };

    stdin.on("data", onData);
  });
}

export function createTerminalSetupPrompts(): SetupPrompts {
  return {
    async choose(list) {
      for (let i = 0; i < list.length; i++) {
        process.stderr.write(`  ${i + 1}) ${list[i].label}\n`);
      }
      const raw = await askLine(`Select [1-${list.length}]: `);
      if (raw === undefined) return undefined;
      const num = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(num) && num >= 1 && num <= list.length) {
        return list[num - 1].value;
      }
      const match = list.find(
        (item) =>
          item.value.toLowerCase() === raw.trim().toLowerCase() ||
          item.label.toLowerCase() === raw.trim().toLowerCase(),
      );
      return match?.value;
    },
    async input(label, initial) {
      const suffix = initial ? ` [${initial}]` : "";
      const raw = await askLine(`${label}${suffix}: `);
      if (raw === undefined) return undefined;
      return raw.trim() || initial || "";
    },
    secret: (label) => askSecret(label),
    async confirm(label, initial = true) {
      const hint = initial ? "[Y/n]" : "[y/N]";
      const raw = await askLine(`${label} ${hint}: `);
      if (raw === undefined) return initial;
      const trimmed = raw.trim().toLowerCase();
      if (!trimmed) return initial;
      return trimmed === "y" || trimmed === "yes";
    },
    async pickModel(models) {
      for (let i = 0; i < models.length; i++) {
        process.stderr.write(`  ${i + 1}) ${models[i].id}\n`);
      }
      const raw = await askLine(`Select model [1-${models.length}]: `);
      if (raw === undefined) return undefined;
      const num = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(num) && num >= 1 && num <= models.length) {
        return models[num - 1].id;
      }
      const trimmed = raw.trim();
      return trimmed || undefined;
    },
  };
}
