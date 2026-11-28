/**
 * Non-interactive and interactive CLI management commands for the endpoint registry:
 * `champ setup`, `champ provider ...`, `champ models ...`, `champ model use`, `champ config ...`.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import type { CredentialStore } from "../config/credential-store";
import { champHome } from "../config/home";
import { onboardEndpoint } from "../config/endpoint-onboarding";
import { selectProviderAsDefault } from "../config/active-model";
import { setConfigValue } from "./config-editor";
import {
  EndpointNotFoundError,
  type EndpointRegistry,
} from "../config/endpoint-registry";
import {
  modelEvidenceSummary,
  runtimeStatusSummary,
} from "../config/model-display";
import type {
  CredentialRef,
  Endpoint,
  ModelSelectionConfig,
  RouteScope,
  RoutingPreference,
  TaskAssignment,
  WorkspaceProviderRef,
} from "../config/provider-model";
import {
  createTerminalSetupPrompts,
  runSetup,
  type SetupPrompts,
} from "./setup";

import type { ScrubSecretsResult } from "../config/provider-migration";
import type { SettingsRepository } from "../config/settings-repository";

export type ProviderCommand =
  | { name: "setup" }
  | { name: "provider-list" }
  | { name: "provider-add" }
  | {
      name: "provider-onboard";
      url: string;
      apiKey?: string;
      endpointName?: string;
    }
  | { name: "provider-edit"; id: string }
  | { name: "provider-remove"; id: string }
  | { name: "provider-test"; id: string; inference?: boolean }
  | { name: "provider-discover"; id: string }
  | { name: "models"; id?: string; details?: boolean }
  | { name: "models-refresh"; id?: string; details?: boolean }
  | { name: "model-use"; endpointAndModel: string; workspace?: boolean }
  | { name: "model-assign"; task: TaskAssignment; endpointAndModel: string }
  | { name: "model-smart"; preference?: RoutingPreference }
  | {
      name: "model-scope";
      scope: RouteScope["kind"];
      id?: string;
      allowCloud?: boolean;
      preference?: RoutingPreference;
    }
  | {
      name: "model-pool-add";
      poolName: string;
      endpointIds: string[];
      preference?: RoutingPreference;
      allowCloud?: boolean;
    }
  | { name: "model-pool-remove"; id: string }
  | {
      name: "model-failover";
      enabled: boolean;
      maxAttempts?: number;
    }
  | { name: "config-show" }
  | { name: "config-set"; key: string; value: string }
  | { name: "config-edit" }
  | { name: "config-validate" }
  | { name: "config-doctor" }
  | { name: "config-export"; redact: boolean }
  | { name: "config-migrate"; dryRun?: boolean }
  | { name: "config-scrub-secrets"; dryRun?: boolean }
  | { name: "config-routing"; mode: "auto" | "manual" };

export interface CommandDeps {
  registry: EndpointRegistry;
  credentials: CredentialStore;
  settings?: SettingsRepository;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompts?: SetupPrompts;
  migrate?: (opts: { dryRun: boolean }) => Promise<{
    endpoints: number;
    warnings: string[];
    written: boolean;
  }>;
  scrubSecrets?: (opts: { dryRun: boolean }) => Promise<ScrubSecretsResult>;
  /** Injectable discovery transport; defaults to global fetch. */
  onboardingFetch?: typeof globalThis.fetch;
}

function redactCredentialRef(ref: CredentialRef): string {
  if (!ref) return "<none>";
  if (ref.kind === "keyring") return `<keyring:${ref.id}>`;
  return `<env:${ref.name}>`;
}

function formatEndpointLine(ep: Endpoint, hasCredential: boolean): string {
  const flags = [
    ep.isDefault ? "default" : null,
    ep.enabled ? "enabled" : "disabled",
  ]
    .filter(Boolean)
    .join(",");
  return `${ep.id}\t${ep.name}\t${ep.provider}\t${ep.baseUrl ?? "(default)"}\t${flags}\thasCredential=${hasCredential}`;
}

function findEndpoint(endpoints: Endpoint[], idOrName: string): Endpoint {
  const byId = endpoints.find((ep) => ep.id === idOrName);
  if (byId) return byId;
  const byName = endpoints.find(
    (ep) => ep.name.toLowerCase() === idOrName.toLowerCase(),
  );
  if (byName) return byName;
  throw new EndpointNotFoundError(idOrName);
}

function writeWorkspaceProviderRef(
  cwd: string,
  endpointId: string,
  model: string,
): string {
  const dir = path.join(cwd, ".champ");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "provider.json");
  const ref: WorkspaceProviderRef = {
    endpoint: endpointId,
    model,
  };
  fs.writeFileSync(target, `${JSON.stringify(ref, null, 2)}\n`, "utf8");
  return target;
}

function requireSettings(deps: CommandDeps): SettingsRepository {
  if (!deps.settings) {
    throw new Error("settings repository is not wired in this build");
  }
  return deps.settings;
}

export async function runProviderCommand(
  cmd: ProviderCommand,
  deps: CommandDeps,
): Promise<number> {
  try {
    switch (cmd.name) {
      case "setup":
      case "provider-add": {
        const prompts = deps.prompts ?? createTerminalSetupPrompts();
        const res = await runSetup({
          registry: deps.registry,
          prompts,
          writeLine: (line) => deps.stderr(`${line}\n`),
        });
        return res.saved ? 0 : 1;
      }

      case "provider-onboard": {
        const result = await onboardEndpoint(
          {
            url: cmd.url,
            apiKey: cmd.apiKey,
            name: cmd.endpointName,
          },
          {
            fetch: deps.onboardingFetch ?? fetch,
            now: () => new Date().toISOString(),
            requestTimeoutMs: 5_000,
          },
        );
        const added = await deps.registry.add({
          id: result.endpoint.id,
          name: result.endpoint.name,
          provider: result.endpoint.provider,
          baseUrl: result.endpoint.baseUrl,
          credential: result.endpoint.credential,
          enabled: true,
          models: result.models,
          options: result.endpoint.options,
        });
        if (cmd.apiKey && added.credential) {
          await deps.credentials.set(added.credential, cmd.apiKey);
        }
        for (const warning of result.warnings) {
          deps.stderr(`champ: ${warning}\n`);
        }
        if (result.error) {
          deps.stderr(`champ: onboarding incomplete: ${result.error}\n`);
          deps.stdout(
            `Saved ${added.id} with ${result.models.length} manually entered model(s).\n`,
          );
          return 1;
        }
        deps.stdout(
          `Detected ${result.protocol}; saved ${added.id} (${added.name}) with ${result.models.length} model(s).\n`,
        );
        for (const model of result.models) {
          deps.stdout(`${added.id}/${model.id}\n`);
        }
        return 0;
      }

      case "provider-list": {
        const endpoints = await deps.registry.list();
        if (endpoints.length === 0) {
          deps.stdout(
            'No endpoints configured. Run "champ setup" to configure one.\n',
          );
          return 0;
        }
        for (const ep of endpoints) {
          const hasCredential = Boolean(
            ep.credential && (await deps.credentials.get(ep.credential)),
          );
          deps.stdout(`${formatEndpointLine(ep, hasCredential)}\n`);
        }
        return 0;
      }

      case "provider-edit": {
        const endpoints = await deps.registry.list();
        const target = findEndpoint(endpoints, cmd.id);
        const prompts = deps.prompts ?? createTerminalSetupPrompts();
        const name = await prompts.input("Endpoint name", target.name);
        if (name === undefined) return 1;
        const baseUrl = await prompts.input("Base URL", target.baseUrl ?? "");
        if (baseUrl === undefined) return 1;
        const enabled = await prompts.confirm("Enabled?", target.enabled);
        const updated = await deps.registry.update(target.id, {
          name: name.trim() || target.name,
          baseUrl: baseUrl.trim() || undefined,
          enabled,
        });
        deps.stdout(`Updated endpoint ${updated.id} (${updated.name}).\n`);
        return 0;
      }

      case "provider-remove": {
        const doc = await deps.registry.readDocument();
        const target = findEndpoint(doc.endpoints, cmd.id);
        const danglingTasks = Object.entries(doc.assignments)
          .filter(([, assign]) => assign?.endpointId === target.id)
          .map(([task]) => task as TaskAssignment);

        await deps.registry.remove(target.id);
        const cleanedNote =
          danglingTasks.length > 0
            ? ` Cleared assignments: ${danglingTasks.join(", ")}.`
            : "";
        deps.stdout(
          `Removed endpoint ${target.id} (${target.name}).${cleanedNote}\n`,
        );
        return 0;
      }

      case "provider-test": {
        const endpoints = await deps.registry.list();
        const target = findEndpoint(endpoints, cmd.id);
        const result = await deps.registry.test(target.id, {
          inference: cmd.inference,
        });
        const phase =
          result.mode ?? (cmd.inference ? "inference" : "connectivity+auth");
        if (!result.ok) {
          const credHint = target.credential
            ? ` (credential: ${redactCredentialRef(target.credential)})`
            : "";
          deps.stderr(
            `champ: test failed [${phase}] for ${target.id} (${target.name})${credHint}: ${result.error ?? "unreachable"}\n`,
          );
          return 1;
        }
        const detail = result.detail ? ` — ${result.detail}` : "";
        deps.stdout(
          `OK ${target.id} (${target.name}) [${phase}] latency=${result.latencyMs ?? 0}ms${detail}\n`,
        );
        return 0;
      }

      case "provider-discover": {
        const endpoints = await deps.registry.list();
        const target = findEndpoint(endpoints, cmd.id);
        const models = await deps.registry.discover(target.id);
        if (models.length === 0) {
          deps.stderr(
            `Warning: no models discovered for ${target.id} (${target.name}).\n`,
          );
          return 0;
        }
        for (const m of models) {
          deps.stdout(`${target.id}/${m.id}\n`);
        }
        return 0;
      }

      case "models":
      case "models-refresh": {
        const endpoints = await deps.registry.list();
        const targets = cmd.id
          ? [findEndpoint(endpoints, cmd.id)]
          : endpoints.filter((ep) => ep.enabled);

        if (targets.length === 0) {
          deps.stderr(
            'Warning: no enabled endpoints configured. Run "champ setup" first.\n',
          );
          return 0;
        }

        const forceRefresh = cmd.name === "models-refresh";
        const selection = cmd.details
          ? await deps.registry.getSelection()
          : undefined;
        if (selection) {
          const pinned = selection.pinned
            ? `${selection.pinned.endpointId}/${selection.pinned.modelId}`
            : "no";
          deps.stdout(
            `Selection: scope=${selection.scope.kind} pinned=${pinned} preference=${selection.preference}\n`,
          );
          const doc = await deps.registry.readDocument();
          for (const pool of doc.pools ?? []) {
            deps.stdout(
              `Pool: ${pool.id} endpoints=${pool.endpointIds.join(",") || "none"}\n`,
            );
          }
        }
        for (const ep of targets) {
          const models =
            forceRefresh || ep.models.length === 0
              ? await deps.registry.discover(ep.id)
              : ep.models;
          if (models.length === 0) {
            deps.stderr(
              `Warning: no models available for ${ep.id} (${ep.name}); endpoint may be unreachable.\n`,
            );
            continue;
          }
          for (const m of models) {
            if (!selection) {
              deps.stdout(`${ep.id}/${m.id}\n`);
              continue;
            }
            const context =
              m.overrides?.contextWindow ?? m.contextWindow ?? ep.contextWindow;
            const status = runtimeStatusSummary(deps.registry.runtime, {
              endpointId: ep.id,
              modelId: m.id,
            });
            deps.stdout(
              `${ep.id}/${m.id}\tname=${ep.name}\tctx=${context ?? "unknown"}\t` +
                `evidence=${modelEvidenceSummary(m)}\tstatus=${status}\t` +
                `lastSeen=${m.lastSeenAt ?? "unknown"}\n`,
            );
          }
        }
        return 0;
      }

      case "model-use": {
        const slash = cmd.endpointAndModel.indexOf("/");
        if (slash <= 0 || slash === cmd.endpointAndModel.length - 1) {
          deps.stderr(
            "champ: expected <endpoint-id>/<model> (e.g. ep_1234/qwen2.5-coder)\n",
          );
          return 2;
        }
        const endpointId = cmd.endpointAndModel.slice(0, slash);
        const model = cmd.endpointAndModel.slice(slash + 1);
        const endpoints = await deps.registry.list();
        const target = findEndpoint(endpoints, endpointId);

        if (cmd.workspace) {
          const filePath = writeWorkspaceProviderRef(
            deps.cwd,
            target.id,
            model,
          );
          deps.stdout(
            `Saved workspace reference ${target.id}/${model} to ${filePath}\n`,
          );
          return 0;
        }

        await deps.registry.setAssignment("default", target.id, model);
        deps.stdout(`Default model set to ${target.id}/${model}\n`);
        return 0;
      }

      case "model-assign": {
        const slash = cmd.endpointAndModel.indexOf("/");
        if (slash <= 0 || slash === cmd.endpointAndModel.length - 1) {
          deps.stderr(
            "champ: expected <endpoint-id>/<model> (e.g. ep_1234/qwen2.5-coder)\n",
          );
          return 2;
        }
        const endpointId = cmd.endpointAndModel.slice(0, slash);
        const model = cmd.endpointAndModel.slice(slash + 1);
        const endpoints = await deps.registry.list();
        const target = findEndpoint(endpoints, endpointId);
        await deps.registry.setAssignment(cmd.task, target.id, model);
        deps.stdout(`Task "${cmd.task}" assigned to ${target.id}/${model}\n`);
        return 0;
      }

      case "model-smart": {
        const current = await deps.registry.getSelection();
        const endpoints = await deps.registry.list();
        const fallback =
          endpoints.find((ep) => ep.enabled && ep.isDefault) ??
          endpoints.find((ep) => ep.enabled);
        const scope: RouteScope =
          current?.scope ??
          (fallback
            ? { kind: "endpoint", endpointId: fallback.id }
            : { kind: "global", allowCloud: false });
        const selection: ModelSelectionConfig = {
          scope,
          preference: cmd.preference ?? current?.preference ?? "balanced",
          pinned: null,
          ...(current?.failover ? { failover: current.failover } : {}),
        };
        await deps.registry.setSelection(selection);
        deps.stdout(
          `SmartRoute enabled in ${scope.kind} scope with ${selection.preference} preference.\n`,
        );
        return 0;
      }

      case "model-scope": {
        const current = await deps.registry.getSelection();
        let scope: RouteScope;
        if (cmd.scope === "endpoint") {
          const endpoints = await deps.registry.list();
          const target = findEndpoint(endpoints, cmd.id ?? "");
          scope = { kind: "endpoint", endpointId: target.id };
        } else if (cmd.scope === "pool") {
          const pools = await deps.registry.listPools();
          const pool =
            pools.find((item) => item.id === cmd.id) ??
            pools.find((item) => item.name === cmd.id);
          if (!pool) throw new Error(`Endpoint pool "${cmd.id}" not found`);
          scope = { kind: "pool", poolId: pool.id };
        } else {
          scope = { kind: "global", allowCloud: cmd.allowCloud === true };
        }
        const preference = cmd.preference ?? current?.preference ?? "balanced";
        await deps.registry.setSelection({
          scope,
          preference,
          pinned: null,
          ...(current?.failover ? { failover: current.failover } : {}),
        });
        deps.stdout(
          `Routing scope set to ${scope.kind} (preference=${preference}).\n`,
        );
        return 0;
      }

      case "model-pool-add": {
        const endpoints = await deps.registry.list();
        const endpointIds = cmd.endpointIds.map(
          (id) => findEndpoint(endpoints, id).id,
        );
        const pool = await deps.registry.addPool({
          name: cmd.poolName,
          endpointIds,
          ...(cmd.preference ? { preference: cmd.preference } : {}),
          ...(cmd.allowCloud !== undefined
            ? { allowCloud: cmd.allowCloud }
            : {}),
        });
        deps.stdout(
          `Pool ${pool.id} (${pool.name}) created with ${pool.endpointIds.length} endpoint(s).\n`,
        );
        return 0;
      }

      case "model-pool-remove": {
        await deps.registry.removePool(cmd.id);
        deps.stdout(`Pool ${cmd.id} removed.\n`);
        return 0;
      }

      case "model-failover": {
        const current = await deps.registry.getSelection();
        const endpoints = await deps.registry.list();
        const fallback =
          endpoints.find((ep) => ep.enabled && ep.isDefault) ??
          endpoints.find((ep) => ep.enabled);
        const scope: RouteScope =
          current?.scope ??
          (fallback
            ? { kind: "endpoint", endpointId: fallback.id }
            : { kind: "global", allowCloud: false });
        const selection: ModelSelectionConfig = {
          scope,
          preference: current?.preference ?? "balanced",
          pinned: current?.pinned ?? null,
        };
        if (cmd.enabled) {
          selection.failover = {
            enabled: true,
            maxAttempts: cmd.maxAttempts ?? current?.failover?.maxAttempts ?? 1,
          };
        }
        await deps.registry.setSelection(selection);
        deps.stdout(
          cmd.enabled
            ? `Safe failover enabled (max ${selection.failover?.maxAttempts ?? 1} retry attempt(s)).\n`
            : "Safe failover disabled.\n",
        );
        return 0;
      }

      case "config-show": {
        const settings = requireSettings(deps);
        const exported = JSON.parse(
          await settings.export({ redact: false }),
        ) as Record<string, unknown>;
        const registryDoc = exported.registry as {
          endpoints: Array<Record<string, unknown> & { credential?: unknown }>;
        };
        const selection = exported.selection as {
          endpoint?: { provider?: string; name?: string; id?: string };
          model?: string;
          source?: string;
          reason?: string;
        } | null;
        const redacted = {
          ...exported,
          effective: selection?.endpoint
            ? {
                provider: selection.endpoint.provider,
                endpoint: selection.endpoint.id,
                model: selection.model,
                source: selection.source,
                reason: selection.reason,
              }
            : null,
          registry: {
            ...registryDoc,
            endpoints: registryDoc.endpoints.map((ep) => ({
              ...ep,
              credential: redactCredentialRef(ep.credential as never),
            })),
          },
        };
        deps.stdout(`${JSON.stringify(redacted, null, 2)}\n`);
        return 0;
      }

      case "config-set": {
        const configPath =
          process.env.CHAMP_CONFIG ??
          path.join(champHome(), ".champ", "config.yaml");
        const assignment = await deps.registry.resolveAssignment("default");
        const endpoint = assignment?.endpoint;
        deps.stdout(
          `${await setConfigValue({
            configPath,
            key: cmd.key,
            value: cmd.value,
            endpoint: endpoint
              ? {
                  endpointId: endpoint.id,
                  endpoint,
                  baseUrl: endpoint.baseUrl,
                  model: assignment?.model,
                }
              : undefined,
            onEndpoint: async (field, value) => {
              if (!endpoint)
                throw new Error(
                  'no default endpoint; run "champ provider add" first',
                );
              if (field === "baseUrl") {
                await deps.registry.update(endpoint.id, { baseUrl: value });
                try {
                  await deps.registry.discover(endpoint.id);
                } catch {
                  // The URL can be saved before the server is reachable.
                }
              } else {
                await deps.registry.setAssignment(
                  "default",
                  endpoint.id,
                  value,
                );
              }
            },
            onProvider: async (providerName) => {
              const endpoints = await deps.registry.list();
              if (endpoints.length === 0) return; // legacy YAML-only setup
              await selectProviderAsDefault(deps.registry, providerName);
            },
          })}\n`,
        );
        return 0;
      }

      case "config-edit": {
        const configPath =
          process.env.CHAMP_CONFIG ??
          path.join(champHome(), ".champ", "config.yaml");
        const editor = process.env.VISUAL || process.env.EDITOR;
        if (!editor) {
          deps.stdout(
            `No $EDITOR set. Edit ${configPath} or run "champ config set <key> <value>".\n`,
          );
          return 0;
        }
        const result = spawnSync(editor, [configPath], {
          shell: true,
          stdio: "inherit",
        });
        if (result.error || result.status !== 0) {
          deps.stderr(
            `champ: editor failed: ${result.error?.message ?? `exit ${result.status}`}\n`,
          );
          return 1;
        }
        return 0;
      }

      case "config-validate": {
        const diagnostics = await requireSettings(deps).validate();
        for (const diagnostic of diagnostics) {
          deps.stdout(
            `${diagnostic.level}\t${diagnostic.code}\t${diagnostic.message}\n`,
          );
        }
        return diagnostics.some((d) => d.level === "error") ? 1 : 0;
      }

      case "config-doctor": {
        const report = await requireSettings(deps).doctor();
        for (const check of report.checks) {
          deps.stdout(
            `${check.ok ? "ok" : "FAIL"}\t${check.name}\t${check.detail}\n`,
          );
        }
        for (const diagnostic of report.diagnostics.filter(
          (d) => d.level !== "info",
        )) {
          deps.stdout(
            `${diagnostic.level}\t${diagnostic.code}\t${diagnostic.message}\n`,
          );
        }
        return report.healthy ? 0 : 1;
      }

      case "config-export": {
        if (!cmd.redact) {
          deps.stderr(
            "champ: config export requires --redact so secrets are never printed\n",
          );
          return 2;
        }
        deps.stdout(await requireSettings(deps).export({ redact: true }));
        return 0;
      }

      case "config-migrate": {
        if (!deps.migrate) {
          deps.stderr(
            "champ: YAML migration handler is not wired in this build.\n",
          );
          return 1;
        }
        const result = await deps.migrate({ dryRun: Boolean(cmd.dryRun) });
        for (const warning of result.warnings) {
          deps.stderr(`Warning: ${warning}\n`);
        }
        const action = result.written ? "Migrated" : "Would migrate";
        deps.stdout(`${action} ${result.endpoints} endpoint(s).\n`);
        return 0;
      }

      case "config-scrub-secrets": {
        if (!deps.scrubSecrets) {
          deps.stderr(
            "champ: secret scrub handler is not wired in this build.\n",
          );
          return 1;
        }
        const result = await deps.scrubSecrets({
          dryRun: Boolean(cmd.dryRun),
        });
        for (const skipped of result.skippedKeys) {
          deps.stderr(`Skipped: ${skipped}\n`);
        }
        if (result.scrubbedKeys.length === 0) {
          deps.stdout("No migrated inline YAML secrets to scrub.\n");
          return 0;
        }
        const verb = result.written ? "Scrubbed" : "Would scrub";
        deps.stdout(`${verb}: ${result.scrubbedKeys.join(", ")}\n`);
        return 0;
      }

      case "config-routing": {
        await deps.registry.setRoutingMode(cmd.mode);
        deps.stdout(`Routing mode set to "${cmd.mode}".\n`);
        return 0;
      }
    }
  } catch (err) {
    deps.stderr(`champ: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
