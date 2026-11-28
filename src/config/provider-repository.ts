/**
 * Versioned atomic JSON persistence + exclusive lock for `~/.champ/providers.json`.
 *
 * Guarantees:
 * - Absent file reads as an empty v1 document without creating directories or files.
 * - Unknown schema versions throw a typed error and leave the file untouched.
 * - Individual malformed endpoints are skipped with a warning rather than failing the whole file.
 * - Writes never follow symlinks, create `~/.champ` (0700) and `providers.json` (0600),
 *   and use temp-file + fsync + rename for crash atomicity.
 * - Secrets (e.g. `apiKey`) are stripped and never persisted in JSON.
 */
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { champHome } from "./home";
import {
  emptyProvidersDocument,
  isProviderKind,
  isTaskAssignment,
  PROVIDERS_DOCUMENT_VERSION,
  type CapabilityEvidence,
  type CapabilityEvidenceSource,
  type CapabilityState,
  type CredentialRef,
  type DiscoveredModel,
  type Endpoint,
  type EndpointPool,
  type ModelCapabilitySet,
  type ModelSelectionConfig,
  type ModelTarget,
  type ModelUserOverrides,
  type ProvidersDocument,
  type RouteScope,
  type RoutingPreference,
  type TaskAssignment,
  type TaskEndpointAssignment,
} from "./provider-model";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_AGE_MS = 30_000;
const LOCK_POLL_MS = 15;

export class UnsupportedProvidersVersionError extends Error {
  readonly foundVersion: unknown;
  readonly supportedVersion = PROVIDERS_DOCUMENT_VERSION;

  constructor(foundVersion: unknown) {
    super(
      `Unsupported providers registry version ${JSON.stringify(foundVersion)} (supported version: ${PROVIDERS_DOCUMENT_VERSION})`,
    );
    this.name = "UnsupportedProvidersVersionError";
    this.foundVersion = foundVersion;
  }
}

export class InvalidProvidersDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProvidersDocumentError";
  }
}

export class LockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out waiting for endpoint registry lock after ${timeoutMs}ms`);
    this.name = "LockTimeoutError";
  }
}

export interface EndpointRepositoryOptions {
  /** Overrides `os.homedir()` for isolated tests. */
  homeDir?: string;
  /** File name inside `<homeDir>/.champ`. Default: `providers.json`. */
  fileName?: string;
  /** Optional warning sink for skipped malformed endpoints. */
  warn?: (message: string) => void;
  /** Test seam for deterministic clock checks. */
  nowMs?: () => number;
  /** Test seam invoked right before atomic rename. */
  onBeforeRename?: (tmpPath: string) => Promise<void>;
  /** Test seam replacing `os.homedir` when `homeDir` is omitted. */
  resolveHomeDir?: () => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCredentialRef(raw: unknown): CredentialRef | undefined {
  if (raw === null) return null;
  if (!isPlainObject(raw)) return undefined;
  if (
    raw.kind === "keyring" &&
    typeof raw.id === "string" &&
    raw.id.trim().length > 0
  ) {
    return { kind: "keyring", id: raw.id };
  }
  if (
    raw.kind === "env" &&
    typeof raw.name === "string" &&
    raw.name.trim().length > 0
  ) {
    return { kind: "env", name: raw.name };
  }
  return undefined;
}

const CAPABILITY_STATES: readonly CapabilityState[] = ["yes", "no", "unknown"];
const EVIDENCE_SOURCES: readonly CapabilityEvidenceSource[] = [
  "server",
  "probe",
  "user",
  "catalog",
];
const ROUTING_PREFERENCES: readonly RoutingPreference[] = [
  "quality",
  "balanced",
  "fast",
];

function normalizeCapabilityState(raw: unknown): CapabilityState | undefined {
  return typeof raw === "string" &&
    (CAPABILITY_STATES as readonly string[]).includes(raw)
    ? (raw as CapabilityState)
    : undefined;
}

function normalizeEvidence(raw: unknown): CapabilityEvidence | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (
    typeof raw.source !== "string" ||
    !(EVIDENCE_SOURCES as readonly string[]).includes(raw.source)
  ) {
    return undefined;
  }
  const evidence: CapabilityEvidence = {
    source: raw.source as CapabilityEvidenceSource,
  };
  if (typeof raw.observedAt === "string") evidence.observedAt = raw.observedAt;
  if (typeof raw.detail === "string") evidence.detail = raw.detail;
  return evidence;
}

function normalizeCapabilitySet(
  raw: unknown,
): Partial<ModelCapabilitySet> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const result: Partial<ModelCapabilitySet> = {};
  for (const key of [
    "chat",
    "tools",
    "embeddings",
    "images",
    "structuredOutput",
  ] as const) {
    const value = normalizeCapabilityState(raw[key]);
    if (value) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCapabilityEvidence(
  raw: unknown,
): Partial<Record<keyof ModelCapabilitySet, CapabilityEvidence>> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const result: Partial<Record<keyof ModelCapabilitySet, CapabilityEvidence>> =
    {};
  for (const key of [
    "chat",
    "tools",
    "embeddings",
    "images",
    "structuredOutput",
  ] as const) {
    const evidence = normalizeEvidence(raw[key]);
    if (evidence) result[key] = evidence;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeUserOverrides(raw: unknown): ModelUserOverrides | undefined {
  if (!isPlainObject(raw)) return undefined;
  const result: ModelUserOverrides = {};
  if (typeof raw.pinned === "boolean") result.pinned = raw.pinned;
  const caps = normalizeCapabilitySet(raw.capabilityOverrides);
  if (caps) result.capabilityOverrides = caps;
  if (
    typeof raw.contextWindow === "number" &&
    Number.isFinite(raw.contextWindow) &&
    raw.contextWindow > 0
  ) {
    result.contextWindow = raw.contextWindow;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizePreference(raw: unknown): RoutingPreference | undefined {
  return typeof raw === "string" &&
    (ROUTING_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as RoutingPreference)
    : undefined;
}

function normalizePositiveNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : undefined;
}

function normalizeModels(raw: unknown): DiscoveredModel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const models: DiscoveredModel[] = [];
  for (const item of raw) {
    if (
      !isPlainObject(item) ||
      typeof item.id !== "string" ||
      !item.id.trim()
    ) {
      continue;
    }
    const model: DiscoveredModel = { id: item.id };
    if (typeof item.displayName === "string")
      model.displayName = item.displayName;
    if (Array.isArray(item.capabilities)) {
      model.capabilities = item.capabilities.filter(
        (c): c is string => typeof c === "string",
      );
    }
    const contextWindow = normalizePositiveNumber(item.contextWindow);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (typeof item.lastSeenAt === "string") model.lastSeenAt = item.lastSeenAt;
    const capabilitySet = normalizeCapabilitySet(item.capabilitySet);
    if (capabilitySet) model.capabilitySet = capabilitySet;
    const capabilityEvidence = normalizeCapabilityEvidence(
      item.capabilityEvidence,
    );
    if (capabilityEvidence) model.capabilityEvidence = capabilityEvidence;
    const contextEvidence = normalizeEvidence(item.contextWindowEvidence);
    if (contextEvidence) model.contextWindowEvidence = contextEvidence;
    for (const key of [
      "maxOutputTokens",
      "qualityHint",
      "latencyMs",
      "ttftMs",
      "costPerMillionInputUsd",
      "costPerMillionOutputUsd",
    ] as const) {
      const value = normalizePositiveNumber(item[key]);
      if (value !== undefined) {
        (model as unknown as Record<string, number>)[key] = value;
      }
    }
    if (
      item.speedHint === "fast" ||
      item.speedHint === "medium" ||
      item.speedHint === "slow"
    ) {
      model.speedHint = item.speedHint;
    }
    const overrides = normalizeUserOverrides(item.overrides);
    if (overrides) model.overrides = overrides;
    models.push(model);
  }
  return models;
}

function normalizeTarget(raw: unknown): ModelTarget | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.endpointId !== "string" || !raw.endpointId.trim())
    return undefined;
  if (typeof raw.modelId !== "string" || !raw.modelId.trim()) return undefined;
  return { endpointId: raw.endpointId, modelId: raw.modelId };
}

function normalizeScope(raw: unknown): RouteScope | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.kind === "endpoint" && typeof raw.endpointId === "string") {
    return { kind: "endpoint", endpointId: raw.endpointId };
  }
  if (raw.kind === "pool" && typeof raw.poolId === "string") {
    return { kind: "pool", poolId: raw.poolId };
  }
  if (raw.kind === "global") {
    return { kind: "global", allowCloud: raw.allowCloud === true };
  }
  return undefined;
}

function normalizeFailover(
  raw: unknown,
): ModelSelectionConfig["failover"] | undefined {
  if (!isPlainObject(raw) || raw.enabled !== true) return undefined;
  const maxAttempts = raw.maxAttempts;
  return {
    enabled: true,
    ...(typeof maxAttempts === "number" &&
    Number.isInteger(maxAttempts) &&
    maxAttempts >= 1 &&
    maxAttempts <= 3
      ? { maxAttempts }
      : {}),
  };
}

function normalizeSelection(raw: unknown): ModelSelectionConfig | undefined {
  if (!isPlainObject(raw)) return undefined;
  const scope = normalizeScope(raw.scope);
  const preference = normalizePreference(raw.preference);
  if (!scope || !preference) return undefined;
  const config: ModelSelectionConfig = {
    scope,
    preference,
    pinned: raw.pinned === null ? null : (normalizeTarget(raw.pinned) ?? null),
  };
  const failover = normalizeFailover(raw.failover);
  if (failover) config.failover = failover;
  return config;
}

function normalizePools(
  raw: unknown,
  endpointIds: ReadonlySet<string>,
): EndpointPool[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pools: EndpointPool[] = [];
  for (const item of raw) {
    if (
      !isPlainObject(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      !Array.isArray(item.endpointIds)
    ) {
      continue;
    }
    const pool: EndpointPool = {
      id: item.id,
      name: item.name,
      endpointIds: [
        ...new Set(
          item.endpointIds.filter(
            (id): id is string => typeof id === "string" && endpointIds.has(id),
          ),
        ),
      ],
    };
    if (isPlainObject(item.routing)) {
      const routing: EndpointPool["routing"] = {};
      const preference = normalizePreference(item.routing.preference);
      if (preference) routing.preference = preference;
      if (typeof item.routing.allowCloud === "boolean") {
        routing.allowCloud = item.routing.allowCloud;
      }
      if (Object.keys(routing).length > 0) pool.routing = routing;
    }
    pools.push(pool);
  }
  return pools;
}

function normalizeEndpoint(raw: unknown): Endpoint | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (!isProviderKind(raw.provider)) return null;
  const credential = normalizeCredentialRef(raw.credential);
  if (credential === undefined) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (typeof raw.isDefault !== "boolean") return null;
  const models = normalizeModels(raw.models);
  if (models === undefined) return null;

  const ep: Endpoint = {
    id: raw.id,
    name: raw.name,
    provider: raw.provider,
    credential,
    enabled: raw.enabled,
    isDefault: raw.isDefault,
    models,
  };
  if (typeof raw.baseUrl === "string") ep.baseUrl = raw.baseUrl;
  if (typeof raw.supportsTools === "boolean")
    ep.supportsTools = raw.supportsTools;
  if (
    typeof raw.contextWindow === "number" &&
    Number.isFinite(raw.contextWindow)
  ) {
    ep.contextWindow = raw.contextWindow;
  }
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)) {
    ep.maxTokens = raw.maxTokens;
  }
  if (isPlainObject(raw.options)) ep.options = { ...raw.options };
  if (typeof raw.lastDiscoveredAt === "string")
    ep.lastDiscoveredAt = raw.lastDiscoveredAt;
  return ep;
}

function serializeDocument(doc: ProvidersDocument): ProvidersDocument {
  if (doc.version !== PROVIDERS_DOCUMENT_VERSION) {
    throw new UnsupportedProvidersVersionError(doc.version);
  }
  const endpoints: Endpoint[] = [];
  for (const ep of doc.endpoints) {
    const clean = normalizeEndpoint(ep);
    if (clean) endpoints.push(clean);
  }
  const assignments: Partial<Record<TaskAssignment, TaskEndpointAssignment>> =
    {};
  if (isPlainObject(doc.assignments)) {
    for (const [key, val] of Object.entries(doc.assignments)) {
      if (
        isTaskAssignment(key) &&
        isPlainObject(val) &&
        typeof val.endpointId === "string" &&
        val.endpointId.trim() &&
        typeof val.model === "string" &&
        val.model.trim()
      ) {
        assignments[key] = { endpointId: val.endpointId, model: val.model };
      }
    }
  }
  const clean: ProvidersDocument = {
    version: PROVIDERS_DOCUMENT_VERSION,
    endpoints,
    assignments,
    routingMode: doc.routingMode === "manual" ? "manual" : "auto",
  };
  const endpointIds = new Set(endpoints.map((ep) => ep.id));
  const pools = normalizePools(doc.pools, endpointIds);
  if (pools) clean.pools = pools;
  const selection = normalizeSelection(doc.selection);
  if (selection) clean.selection = selection;
  return clean;
}

export class EndpointRepository {
  private readonly dirPath: string;
  private readonly filePath: string;
  private readonly warn: (message: string) => void;
  private readonly nowMs: () => number;
  private readonly onBeforeRename?: (tmpPath: string) => Promise<void>;

  constructor(opts?: EndpointRepositoryOptions) {
    const home = opts?.homeDir ?? opts?.resolveHomeDir?.() ?? champHome();
    this.dirPath = path.join(home, ".champ");
    this.filePath = path.join(this.dirPath, opts?.fileName ?? "providers.json");
    this.warn =
      opts?.warn ??
      ((message: string) => process.stderr.write(`[champ] ${message}\n`));
    this.nowMs = opts?.nowMs ?? (() => Date.now());
    this.onBeforeRename = opts?.onBeforeRename;
  }

  path(): string {
    return this.filePath;
  }

  async read(): Promise<ProvidersDocument> {
    let rawText: string;
    try {
      rawText = await fs.promises.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyProvidersDocument();
      }
      throw new InvalidProvidersDocumentError(
        `Failed to read ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new InvalidProvidersDocumentError(
        `Malformed JSON in ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!isPlainObject(parsed)) {
      throw new InvalidProvidersDocumentError(
        `Invalid providers document in ${this.filePath}: expected JSON object`,
      );
    }

    if (parsed.version !== PROVIDERS_DOCUMENT_VERSION) {
      throw new UnsupportedProvidersVersionError(parsed.version);
    }

    if (!Array.isArray(parsed.endpoints)) {
      throw new InvalidProvidersDocumentError(
        `Invalid providers document in ${this.filePath}: "endpoints" must be an array`,
      );
    }

    const endpoints: Endpoint[] = [];
    for (let idx = 0; idx < parsed.endpoints.length; idx++) {
      const ep = normalizeEndpoint(parsed.endpoints[idx]);
      if (!ep) {
        this.warn(
          `Skipped malformed endpoint entry at index ${idx} in ${this.filePath}`,
        );
        continue;
      }
      endpoints.push(ep);
    }

    const assignments: Partial<Record<TaskAssignment, TaskEndpointAssignment>> =
      {};
    if (isPlainObject(parsed.assignments)) {
      for (const [key, val] of Object.entries(parsed.assignments)) {
        if (
          isTaskAssignment(key) &&
          isPlainObject(val) &&
          typeof val.endpointId === "string" &&
          val.endpointId.trim() &&
          typeof val.model === "string" &&
          val.model.trim()
        ) {
          assignments[key] = { endpointId: val.endpointId, model: val.model };
        }
      }
    }

    const routingMode = parsed.routingMode === "manual" ? "manual" : "auto";
    const doc: ProvidersDocument = {
      version: PROVIDERS_DOCUMENT_VERSION,
      endpoints,
      assignments,
      routingMode,
    };
    const pools = normalizePools(
      parsed.pools,
      new Set(endpoints.map((ep) => ep.id)),
    );
    if (pools) doc.pools = pools;
    const selection = normalizeSelection(parsed.selection);
    if (selection) doc.selection = selection;
    return doc;
  }

  async write(doc: ProvidersDocument): Promise<void> {
    const cleanDoc = serializeDocument(doc);
    await this.ensureDirSafe();
    await this.assertNotSymlink(this.filePath);

    const tmpPath = path.join(
      this.dirPath,
      `.providers.json.tmp.${process.pid}.${randomUUID().slice(0, 8)}`,
    );
    const payload = `${JSON.stringify(cleanDoc, null, 2)}\n`;

    let fh: fs.promises.FileHandle | undefined;
    try {
      fh = await fs.promises.open(tmpPath, "wx", 0o600);
      await fh.writeFile(payload, "utf8");
      await fh.sync();
      await fh.close();
      fh = undefined;
      await fs.promises.chmod(tmpPath, 0o600);

      if (this.onBeforeRename) {
        await this.onBeforeRename(tmpPath);
      }

      await fs.promises.rename(tmpPath, this.filePath);
      await fs.promises.chmod(this.filePath, 0o600);
    } catch (err) {
      if (fh) {
        await fh.close().catch(() => {});
      }
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async withLock<T>(
    fn: () => Promise<T>,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureDirSafe();
    const lockDir = `${this.filePath}.lock`;
    const deadline = this.nowMs() + timeoutMs;

    while (true) {
      try {
        await fs.promises.mkdir(lockDir, { mode: 0o700 });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }

        // Reclaim stale lock atomically via rename so concurrent waiters don't
        // delete a lock freshly acquired by a sibling process.
        try {
          const st = await fs.promises.lstat(lockDir);
          if (this.nowMs() - st.mtimeMs > STALE_LOCK_AGE_MS) {
            const staleDir = `${lockDir}.stale.${randomUUID().slice(0, 8)}`;
            try {
              await fs.promises.rename(lockDir, staleDir);
              await fs.promises.rm(staleDir, { recursive: true, force: true });
              continue;
            } catch {
              // Another waiter won the race or released it; retry normally.
            }
          }
        } catch {
          // Lock vanished between EEXIST and lstat; retry immediately.
          continue;
        }

        if (this.nowMs() >= deadline) {
          throw new LockTimeoutError(timeoutMs);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }

    try {
      return await fn();
    } finally {
      await fs.promises.rm(lockDir, { recursive: true, force: true });
    }
  }

  private async ensureDirSafe(): Promise<void> {
    try {
      const st = await fs.promises.lstat(this.dirPath);
      if (st.isSymbolicLink()) {
        throw new Error(
          `Refusing to use symlinked config directory ${this.dirPath}`,
        );
      }
      if (!st.isDirectory()) {
        throw new Error(
          `Config path ${this.dirPath} exists and is not a directory`,
        );
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    await fs.promises.mkdir(this.dirPath, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.dirPath, 0o700);
  }

  private async assertNotSymlink(targetPath: string): Promise<void> {
    try {
      const st = await fs.promises.lstat(targetPath);
      if (st.isSymbolicLink()) {
        throw new Error(
          `Refusing to write registry through symlink at ${targetPath}`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}
