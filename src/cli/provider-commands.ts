/**
 * Non-interactive and interactive CLI management commands for the endpoint registry:
 * `champ setup`, `champ provider ...`, `champ models ...`, `champ model use`, `champ config ...`.
 */
import * as fs from "fs";
import * as path from "path";
import type { CredentialStore } from "../config/credential-store";
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

export type ProviderCommand =
  | { name: "setup" }
  | { name: "provider-list" }
  | { name: "provider-add" }
  | { name: "provider-edit"; id: string }
  | { name: "provider-remove"; id: string }
  | { name: "provider-test"; id: string }
  | { name: "provider-discover"; id: string }
  | { name: "models"; id?: string }
  | { name: "models-refresh"; id?: string }
  | { name: "model-use"; endpointAndModel: string; workspace?: boolean }
  | { name: "config-show" }
  | { name: "config-migrate"; dryRun?: boolean };

export interface CommandDeps {
  registry: EndpointRegistry;
  credentials: CredentialStore;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompts?: SetupPrompts;
  migrate?: (opts: { dryRun: boolean }) => Promise<{
    endpoints: number;
    warnings: string[];
    written: boolean;
  }>;
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
        const result = await deps.registry.test(target.id);
        if (!result.ok) {
          const credHint = target.credential
            ? ` (credential: ${redactCredentialRef(target.credential)})`
            : "";
          deps.stderr(
            `champ: test failed for ${target.id} (${target.name})${credHint}: ${result.error ?? "unreachable"}\n`,
          );
          return 1;
        }
        deps.stdout(
          `OK ${target.id} (${target.name}) latency=${result.latencyMs ?? 0}ms\n`,
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

      case "config-show": {
        const doc = await deps.registry.readDocument();
        const redacted = {
          version: doc.version,
          routingMode: doc.routingMode,
          assignments: doc.assignments,
          endpoints: doc.endpoints.map((ep) => ({
            ...ep,
            credential: redactCredentialRef(ep.credential),
          })),
        };
        deps.stdout(`${JSON.stringify(redacted, null, 2)}\n`);
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
    }
  } catch (err) {
    deps.stderr(`champ: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
