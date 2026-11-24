/**
 * Canonical typed settings repository shared by CLI and VS Code.
 *
 * The endpoint registry stays the authority for endpoints and task
 * assignments; this module adds a single read API over the remaining settings
 * (`~/.champ/config.yaml`) plus diagnostics, doctor checks and redacted export.
 * It does not replace `EndpointRegistry` or introduce a second persistence
 * format.
 */
import * as fs from "fs";
import * as path from "path";
import { champHome } from "./home";
import { ConfigLoader, type ChampConfig } from "./config-loader";
import type { CredentialStore } from "./credential-store";
import {
  ModelSelectionService,
  readWorkspaceProviderRef,
  type ResolvedModelSelection,
} from "./model-selection";
import { catalogEntry, legacySecretIdForProvider } from "./provider-catalog";
import type {
  Endpoint,
  ProvidersDocument,
  WorkspaceProviderRef,
} from "./provider-model";
import { EndpointRepository } from "./provider-repository";

export type DiagnosticLevel = "error" | "warning" | "info";

export type DiagnosticSource =
  | "yaml"
  | "registry"
  | "workspace"
  | "credentials"
  | "selection";

export interface SettingsDiagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  source: DiagnosticSource;
}

export interface SettingsSources {
  yaml: string | null;
  registry: string | null;
  workspace: string | null;
}

export interface EffectiveSettings {
  config: ChampConfig;
  registry: ProvidersDocument;
  workspaceRef: WorkspaceProviderRef | null;
  selection: ResolvedModelSelection | null;
  diagnostics: SettingsDiagnostic[];
  sources: SettingsSources;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport extends EffectiveSettings {
  checks: DoctorCheck[];
  healthy: boolean;
}

export interface SettingsOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export interface SettingsRepositoryOptions {
  homeDir?: string;
  configPath?: string;
  workspaceDir?: string;
  env?: Record<string, string | undefined>;
  overrides?: SettingsOverrides;
  credentials?: Pick<CredentialStore, "get" | "unavailableReason">;
  repository?: Pick<EndpointRepository, "read" | "path">;
  now?: () => string;
}

const SECRET_KEYS = new Set([
  "apikey",
  "token",
  "password",
  "secret",
  "authorization",
]);

function redact(value: unknown, key?: string, hideRefs = true): unknown {
  if (key && SECRET_KEYS.has(key.toLowerCase())) return "<redacted>";
  if (key === "credential" && hideRefs) return "<redacted>";
  if (Array.isArray(value))
    return value.map((item) => redact(item, undefined, hideRefs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, k, hideRefs)]),
    );
  }
  return value;
}

export class SettingsRepository {
  private readonly homeDir: string;
  private readonly configPath: string;
  private readonly workspaceDir?: string;
  private readonly overrides: SettingsOverrides;
  private readonly credentials?: Pick<
    CredentialStore,
    "get" | "unavailableReason"
  >;
  private readonly repository: Pick<EndpointRepository, "read" | "path">;
  private readonly now: () => string;

  constructor(opts: SettingsRepositoryOptions = {}) {
    this.homeDir = opts.homeDir ?? champHome(opts.env ?? process.env);
    this.configPath =
      opts.configPath ??
      opts.env?.CHAMP_CONFIG ??
      process.env.CHAMP_CONFIG ??
      path.join(this.homeDir, ".champ", "config.yaml");
    this.workspaceDir = opts.workspaceDir;
    this.overrides = opts.overrides ?? {};
    this.credentials = opts.credentials;
    this.repository =
      opts.repository ?? new EndpointRepository({ homeDir: this.homeDir });
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Load the effective settings without mutating any file. */
  async load(): Promise<EffectiveSettings> {
    const diagnostics: SettingsDiagnostic[] = [];
    const config = this.readYaml(diagnostics);
    const registry = await this.readRegistry(diagnostics);
    const workspaceRef = this.workspaceDir
      ? readWorkspaceProviderRef(this.workspaceDir, (msg) =>
          diagnostics.push({
            level: "warning",
            code: "workspace-invalid",
            message: msg.replace(/^\[champ\]\s*/, ""),
            source: "workspace",
          }),
        )
      : null;

    this.checkReferences(config, registry, workspaceRef, diagnostics);

    const selectionService = new ModelSelectionService(
      this.repository as EndpointRepository,
    );
    let selection = selectionService.resolveFromDocument(registry, {
      task: "default",
      workspaceDir: this.workspaceDir,
      preferredEndpoint: this.overrides.provider,
      preferredModel: this.overrides.model,
      routingRules: config.routing?.rules,
      tieBreak: config.routing?.tieBreak,
    });

    if (!selection && registry.endpoints.length === 0 && config.provider) {
      diagnostics.push({
        level: "warning",
        code: "legacy-yaml-provider",
        message:
          "No endpoints in providers.json; using the legacy provider block in config.yaml",
        source: "yaml",
      });
      selection = this.legacySelection(config);
    }

    return {
      config,
      registry,
      workspaceRef,
      selection,
      diagnostics,
      sources: {
        yaml: fs.existsSync(this.configPath) ? this.configPath : null,
        registry: this.repository.path(),
        workspace: this.workspaceDir
          ? path.join(this.workspaceDir, ".champ", "provider.json")
          : null,
      },
    };
  }

  /** Return configuration problems only (errors and warnings). */
  async validate(): Promise<SettingsDiagnostic[]> {
    const { diagnostics } = await this.load();
    return diagnostics.filter((d) => d.level !== "info");
  }

  /** Run non-destructive configuration health checks. */
  async doctor(): Promise<DoctorReport> {
    const settings = await this.load();
    const checks: DoctorCheck[] = [];

    const yamlError = settings.diagnostics.find(
      (d) => d.source === "yaml" && d.level === "error",
    );
    checks.push({
      name: "yaml",
      ok: !yamlError,
      detail: yamlError?.message ?? "config.yaml parses cleanly",
    });

    const registryError = settings.diagnostics.find(
      (d) => d.source === "registry" && d.level === "error",
    );
    checks.push({
      name: "registry",
      ok: !registryError,
      detail: registryError?.message ?? "providers.json is readable",
    });

    checks.push({
      name: "selection",
      ok: settings.selection !== null,
      detail: settings.selection
        ? `${settings.selection.endpoint.name} / ${settings.selection.model} (${settings.selection.source})`
        : "no usable endpoint or legacy provider configured",
    });

    if (settings.selection?.endpoint.credential) {
      const ref = settings.selection.endpoint.credential;
      const secret = await this.credentials?.get(ref);
      const missing = !secret;
      if (missing) {
        settings.diagnostics.push({
          level: "warning",
          code: "credential-missing",
          message:
            ref.kind === "env"
              ? `Environment variable ${ref.name} is not set`
              : `No secret stored for credential reference ${ref.id}`,
          source: "credentials",
        });
      }
      const reason = this.credentials?.unavailableReason?.();
      if (reason) {
        settings.diagnostics.push({
          level: "warning",
          code: "keyring-unavailable",
          message: reason,
          source: "credentials",
        });
      }
      checks.push({
        name: "credentials",
        ok: !missing && !reason,
        detail: missing
          ? "credential reference resolves to no secret"
          : reason
            ? reason
            : "credential resolves to a stored secret",
      });
    } else {
      checks.push({
        name: "credentials",
        ok: true,
        detail: "endpoint requires no credential",
      });
    }

    const workspaceMissing = settings.diagnostics.find(
      (d) => d.code === "workspace-endpoint-missing",
    );
    checks.push({
      name: "workspace",
      ok: !workspaceMissing,
      detail:
        workspaceMissing?.message ?? "workspace reference is valid or absent",
    });

    const dangling = settings.diagnostics.filter(
      (d) => d.code === "assignment-dangling",
    );
    checks.push({
      name: "assignments",
      ok: dangling.length === 0,
      detail:
        dangling.length === 0
          ? "all task assignments point to existing endpoints"
          : dangling.map((d) => d.message).join("; "),
    });

    return {
      ...settings,
      checks,
      healthy: checks.every((check) => check.ok),
    };
  }

  /** Serialise the effective settings; secret values are never emitted. */
  async export(opts: { redact?: boolean } = {}): Promise<string> {
    const settings = await this.load();
    const hideRefs = opts.redact !== false;
    return `${JSON.stringify(
      {
        generatedAt: this.now(),
        version: 1,
        sources: settings.sources,
        selection: settings.selection
          ? redact(settings.selection, undefined, hideRefs)
          : null,
        config: redact(settings.config, undefined, hideRefs),
        registry: redact(settings.registry, undefined, hideRefs),
        workspaceRef: redact(settings.workspaceRef, undefined, hideRefs),
        diagnostics: settings.diagnostics,
      },
      null,
      2,
    )}\n`;
  }

  private readYaml(diagnostics: SettingsDiagnostic[]): ChampConfig {
    let text: string | null = null;
    try {
      text = fs.readFileSync(this.configPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({
          level: "error",
          code: "yaml-unreadable",
          message: `Cannot read ${this.configPath}: ${this.message(err)}`,
          source: "yaml",
        });
      }
    }
    if (text === null || !text.trim()) return {};
    try {
      return ConfigLoader.parseYaml(text);
    } catch (err) {
      diagnostics.push({
        level: "error",
        code: "yaml-invalid",
        message: this.message(err),
        source: "yaml",
      });
      return {};
    }
  }

  private async readRegistry(
    diagnostics: SettingsDiagnostic[],
  ): Promise<ProvidersDocument> {
    try {
      return await this.repository.read();
    } catch (err) {
      diagnostics.push({
        level: "error",
        code: "registry-invalid",
        message: this.message(err),
        source: "registry",
      });
      return {
        version: 1,
        endpoints: [],
        assignments: {},
        routingMode: "auto",
      };
    }
  }

  private checkReferences(
    config: ChampConfig,
    registry: ProvidersDocument,
    workspaceRef: WorkspaceProviderRef | null,
    diagnostics: SettingsDiagnostic[],
  ): void {
    const ids = new Set(registry.endpoints.map((ep) => ep.id));
    for (const [task, assignment] of Object.entries(registry.assignments)) {
      if (assignment && !ids.has(assignment.endpointId)) {
        diagnostics.push({
          level: "warning",
          code: "assignment-dangling",
          message: `Task "${task}" references missing endpoint "${assignment.endpointId}"`,
          source: "registry",
        });
      }
    }
    if (workspaceRef?.endpoint && !ids.has(workspaceRef.endpoint)) {
      diagnostics.push({
        level: "warning",
        code: "workspace-endpoint-missing",
        message: `Workspace reference points to missing endpoint "${workspaceRef.endpoint}"`,
        source: "workspace",
      });
    }
    if (config.provider && registry.endpoints.length === 0) {
      // Reported by load() as "legacy-yaml-provider".
      return;
    }
    if (!config.provider && registry.endpoints.length === 0) {
      diagnostics.push({
        level: "info",
        code: "no-provider",
        message: "No endpoint registry entries and no provider in config.yaml",
        source: "selection",
      });
    }
  }

  private legacySelection(config: ChampConfig): ResolvedModelSelection {
    const name = (this.overrides.provider ??
      config.provider ??
      "ollama") as Endpoint["provider"];
    const entry = catalogEntry(name);
    const configured = config.providers?.[name];
    const model =
      this.overrides.model ??
      configured?.model ??
      entry.defaultModel ??
      "default";
    const endpoint: Endpoint = {
      id: `legacy:${name}`,
      name: `Legacy ${name} (config.yaml)`,
      provider: name,
      baseUrl:
        this.overrides.baseUrl ?? configured?.baseUrl ?? entry.defaultBaseUrl,
      credential: configured?.apiKey
        ? { kind: "keyring", id: legacySecretIdForProvider(name) }
        : null,
      enabled: true,
      isDefault: true,
      supportsTools: entry.supportsTools,
      contextWindow: configured?.contextWindow,
      models: [{ id: model }],
    };
    return {
      endpoint,
      model,
      task: "default",
      source: "default-endpoint",
      reason: "legacy provider block in ~/.champ/config.yaml",
      fallbacks: [],
      routingMode: config.routing?.mode === "manual" ? "manual" : "auto",
    };
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
