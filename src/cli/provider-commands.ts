/**
 * Non-interactive and interactive CLI management commands for the endpoint registry:
 * `champ setup`, `champ provider ...`, `champ models ...`, `champ model use`, `champ config ...`.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import type { CredentialStore } from "../config/credential-store";
import { champHome } from "../config/home";
import { setConfigValue } from "./config-editor";
import {
  EndpointNotFoundError,
  type EndpointRegistry,
} from "../config/endpoint-registry";
import type {
  CredentialRef,
  Endpoint,
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
  | { name: "provider-edit"; id: string }
  | { name: "provider-remove"; id: string }
  | { name: "provider-test"; id: string; inference?: boolean }
  | { name: "provider-discover"; id: string }
  | { name: "models"; id?: string }
  | { name: "models-refresh"; id?: string }
  | { name: "model-use"; endpointAndModel: string; workspace?: boolean }
  | { name: "model-assign"; task: TaskAssignment; endpointAndModel: string }
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
            deps.stdout(`${ep.id}/${m.id}\n`);
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

      case "config-show": {
        const settings = requireSettings(deps);
        const exported = JSON.parse(
          await settings.export({ redact: false }),
        ) as Record<string, unknown>;
        const registryDoc = exported.registry as {
          endpoints: Array<Record<string, unknown> & { credential?: unknown }>;
        };
        const redacted = {
          ...exported,
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
