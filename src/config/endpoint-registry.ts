/**
 * Shared endpoint configuration service (`EndpointRegistry`) for CLI and extension.
 *
 * Owns endpoint CRUD, single-enabled-default invariants, task assignments,
 * onChange notifications, and credential-backed model discovery/testing.
 * Named `EndpointRegistry` (not `ProviderRegistry`) to avoid colliding with
 * the runtime LLM provider container in `src/providers/registry.ts`.
 */
import { randomUUID } from "crypto";
import type {
  CredentialStore,
  CredentialWriteStatus,
} from "./credential-store";
import type {
  discoverModels,
  DiscoveryDeps,
  EndpointTestResult,
  testEndpoint,
  TestEndpointOptions,
} from "./model-discovery";
import { catalogEntry } from "./provider-catalog";
import {
  isProviderKind,
  type CredentialRef,
  type DiscoveredModel,
  type Endpoint,
  type EndpointPool,
  type ModelSelectionConfig,
  type ModelTarget,
  type ProviderKind,
  type ProvidersDocument,
  type RoutingPreference,
  type TaskAssignment,
} from "./provider-model";
import {
  ModelRouter,
  type RouteDecision,
  type RouteDecisionInput,
} from "./model-router";
import { RuntimeState, type FailureClass } from "./runtime-status";
import type { EndpointRepository } from "./provider-repository";

export class DuplicateEndpointError extends Error {
  constructor(name: string) {
    super(`Endpoint "${name}" already exists`);
    this.name = "DuplicateEndpointError";
  }
}

export class EndpointNotFoundError extends Error {
  constructor(id: string) {
    super(`Endpoint "${id}" not found`);
    this.name = "EndpointNotFoundError";
  }
}

export interface AddEndpointInput {
  id?: string;
  name: string;
  provider: ProviderKind;
  baseUrl?: string;
  isDefault?: boolean;
  enabled?: boolean;
  supportsTools?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  options?: Record<string, unknown>;
  credential?: CredentialRef;
  models?: DiscoveredModel[];
}

export interface EndpointRegistryDeps {
  repository: EndpointRepository;
  credentials: CredentialStore;
  discovery: {
    discoverModels: typeof discoverModels;
    testEndpoint: typeof testEndpoint;
  };
  now: () => string;
  fetch?: typeof fetch;
}

function findEndpointOrThrow(doc: ProvidersDocument, id: string): Endpoint {
  const ep = doc.endpoints.find((item) => item.id === id);
  if (!ep) throw new EndpointNotFoundError(id);
  return ep;
}

function hasDuplicateName(
  doc: ProvidersDocument,
  name: string,
  excludeId?: string,
): boolean {
  const needle = name.trim().toLowerCase();
  return doc.endpoints.some(
    (ep) => ep.id !== excludeId && ep.name.trim().toLowerCase() === needle,
  );
}

function defaultModelForEndpoint(ep: Endpoint): string {
  return ep.models[0]?.id ?? "";
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

function endpointDedupKey(ep: Endpoint): string {
  return `${ep.provider}|${normalizeBaseUrl(ep.baseUrl)}`;
}

export class EndpointRegistry {
  private readonly deps: EndpointRegistryDeps;
  private readonly listeners = new Set<() => void>();
  readonly runtime = new RuntimeState();
  readonly router = new ModelRouter(this.runtime);

  constructor(deps: EndpointRegistryDeps) {
    this.deps = deps;
  }

  private discoveryDeps(): DiscoveryDeps {
    return {
      fetch: this.deps.fetch ?? fetch,
      now: this.deps.now,
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async readDocument(): Promise<ProvidersDocument> {
    return this.deps.repository.read();
  }

  async list(): Promise<Endpoint[]> {
    const doc = await this.deps.repository.read();
    return doc.endpoints;
  }

  async add(input: AddEndpointInput): Promise<Endpoint> {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error("Endpoint name must not be empty");
    }
    if (!isProviderKind(input.provider)) {
      throw new Error(`Unknown provider "${String(input.provider)}"`);
    }

    const entry = catalogEntry(input.provider);
    const created = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      if (hasDuplicateName(doc, trimmedName)) {
        throw new DuplicateEndpointError(trimmedName);
      }

      const id = input.id?.trim() || `ep_${randomUUID().slice(0, 8)}`;
      if (doc.endpoints.some((ep) => ep.id === id)) {
        throw new DuplicateEndpointError(id);
      }

      const enabled = input.enabled ?? true;
      const shouldDefault =
        enabled && (doc.endpoints.length === 0 || input.isDefault === true);
      if (shouldDefault) {
        for (const existing of doc.endpoints) {
          existing.isDefault = false;
        }
      }

      const credential: CredentialRef =
        input.credential !== undefined
          ? input.credential
          : entry.auth === "required"
            ? { kind: "keyring", id }
            : null;

      const endpoint: Endpoint = {
        id,
        name: trimmedName,
        provider: input.provider,
        baseUrl: input.baseUrl ?? entry.defaultBaseUrl,
        credential,
        enabled,
        isDefault: shouldDefault,
        supportsTools: input.supportsTools,
        contextWindow: input.contextWindow,
        maxTokens: input.maxTokens,
        options: input.options,
        models: input.models ? [...input.models] : [],
      };
      doc.endpoints.push(endpoint);
      await this.deps.repository.write(doc);
      return endpoint;
    });

    this.emitChange();
    return created;
  }

  async update(
    id: string,
    patch: Partial<AddEndpointInput>,
  ): Promise<Endpoint> {
    const updated = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const ep = findEndpointOrThrow(doc, id);

      if (patch.name !== undefined) {
        const trimmedName = patch.name.trim();
        if (!trimmedName) {
          throw new Error("Endpoint name must not be empty");
        }
        if (hasDuplicateName(doc, trimmedName, id)) {
          throw new DuplicateEndpointError(trimmedName);
        }
        ep.name = trimmedName;
      }

      if (patch.provider !== undefined) {
        if (!isProviderKind(patch.provider)) {
          throw new Error(`Unknown provider "${String(patch.provider)}"`);
        }
        ep.provider = patch.provider;
      }
      if (patch.baseUrl !== undefined) ep.baseUrl = patch.baseUrl;
      if (patch.supportsTools !== undefined)
        ep.supportsTools = patch.supportsTools;
      if (patch.contextWindow !== undefined)
        ep.contextWindow = patch.contextWindow;
      if (patch.maxTokens !== undefined) ep.maxTokens = patch.maxTokens;
      if (patch.options !== undefined) ep.options = patch.options;
      if (patch.credential !== undefined) ep.credential = patch.credential;

      if (patch.enabled !== undefined) {
        ep.enabled = patch.enabled;
        if (!patch.enabled) {
          ep.isDefault = false;
        }
      }

      if (patch.isDefault === true) {
        if (!ep.enabled) {
          throw new Error("Cannot make a disabled endpoint the default");
        }
        for (const other of doc.endpoints) {
          other.isDefault = other.id === id;
        }
      } else if (patch.isDefault === false) {
        ep.isDefault = false;
      }

      await this.deps.repository.write(doc);
      return ep;
    });

    this.emitChange();
    return updated;
  }

  async remove(id: string): Promise<void> {
    const removedCredential = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const idx = doc.endpoints.findIndex((ep) => ep.id === id);
      if (idx === -1) throw new EndpointNotFoundError(id);

      const [removed] = doc.endpoints.splice(idx, 1);

      for (const [task, assignment] of Object.entries(doc.assignments)) {
        if (assignment?.endpointId === id) {
          delete doc.assignments[task as TaskAssignment];
        }
      }

      for (const pool of doc.pools ?? []) {
        pool.endpointIds = pool.endpointIds.filter(
          (endpointId) => endpointId !== id,
        );
        if (
          doc.selection?.scope.kind === "pool" &&
          doc.selection.scope.poolId === pool.id &&
          pool.endpointIds.length === 0
        ) {
          doc.selection.scope = { kind: "global", allowCloud: false };
        }
      }
      if (doc.selection?.pinned?.endpointId === id) {
        doc.selection.pinned = null;
      }
      if (
        doc.selection?.scope.kind === "endpoint" &&
        doc.selection.scope.endpointId === id
      ) {
        const replacement = doc.endpoints.find((ep) => ep.enabled);
        doc.selection.scope = replacement
          ? { kind: "endpoint", endpointId: replacement.id }
          : { kind: "global", allowCloud: false };
      }

      if (removed.isDefault) {
        const replacement = doc.endpoints.find((ep) => ep.enabled);
        if (replacement) {
          replacement.isDefault = true;
        }
      }

      await this.deps.repository.write(doc);
      return removed.credential;
    });

    await this.deps.credentials.delete(removedCredential);
    this.emitChange();
  }

  credentialsUnavailableReason(): string | undefined {
    return this.deps.credentials.unavailableReason?.();
  }

  /** True when any enabled endpoint for the provider already has a usable credential. */
  async hasStoredCredentialForProvider(
    provider: ProviderKind,
  ): Promise<boolean> {
    const endpoints = await this.list();
    for (const ep of endpoints) {
      if (ep.provider !== provider || !ep.enabled) continue;
      if (await this.deps.credentials.get(ep.credential)) return true;
    }
    return false;
  }

  async setCredential(
    id: string,
    secret: string,
  ): Promise<CredentialWriteStatus> {
    const ref = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const ep = findEndpointOrThrow(doc, id);
      if (ep.credential === null) {
        ep.credential = { kind: "keyring", id: ep.id };
        await this.deps.repository.write(doc);
      }
      return ep.credential;
    });

    let status: CredentialWriteStatus;
    if (this.deps.credentials.setWithStatus) {
      status = await this.deps.credentials.setWithStatus(ref, secret);
    } else {
      await this.deps.credentials.set(ref, secret);
      const reason = this.deps.credentials.unavailableReason?.();
      status = {
        persisted: !reason,
        storage: reason ? "env" : "keyring",
        ...(reason ? { reason } : {}),
      };
    }
    this.emitChange();
    return status;
  }

  async setCredentialRef(id: string, credential: CredentialRef): Promise<void> {
    await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const ep = findEndpointOrThrow(doc, id);
      ep.credential = credential;
      await this.deps.repository.write(doc);
    });
    this.emitChange();
  }

  async setRoutingMode(mode: "auto" | "manual"): Promise<void> {
    await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      doc.routingMode = mode;
      await this.deps.repository.write(doc);
    });
    this.emitChange();
  }

  async listPools(): Promise<EndpointPool[]> {
    return (await this.deps.repository.read()).pools ?? [];
  }

  async addPool(input: {
    id?: string;
    name: string;
    endpointIds: string[];
    preference?: RoutingPreference;
    allowCloud?: boolean;
  }): Promise<EndpointPool> {
    const created = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const id = input.id?.trim() || `pool_${randomUUID().slice(0, 8)}`;
      if ((doc.pools ?? []).some((pool) => pool.id === id)) {
        throw new Error(`Endpoint pool "${id}" already exists`);
      }
      const known = new Set(doc.endpoints.map((ep) => ep.id));
      const endpointIds = [...new Set(input.endpointIds)].filter((endpointId) =>
        known.has(endpointId),
      );
      const pool: EndpointPool = {
        id,
        name: input.name.trim(),
        endpointIds,
        ...(input.preference || input.allowCloud !== undefined
          ? {
              routing: {
                ...(input.preference ? { preference: input.preference } : {}),
                ...(input.allowCloud !== undefined
                  ? { allowCloud: input.allowCloud }
                  : {}),
              },
            }
          : {}),
      };
      doc.pools = [...(doc.pools ?? []), pool];
      await this.deps.repository.write(doc);
      return pool;
    });
    this.emitChange();
    return created;
  }

  async updatePool(
    id: string,
    patch: {
      name?: string;
      endpointIds?: string[];
      preference?: RoutingPreference;
      allowCloud?: boolean;
    },
  ): Promise<EndpointPool> {
    const updated = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const pool = (doc.pools ?? []).find((item) => item.id === id);
      if (!pool) throw new Error(`Endpoint pool "${id}" not found`);
      if (patch.name !== undefined) pool.name = patch.name.trim();
      if (patch.endpointIds !== undefined) {
        const known = new Set(doc.endpoints.map((ep) => ep.id));
        pool.endpointIds = [...new Set(patch.endpointIds)].filter(
          (endpointId) => known.has(endpointId),
        );
      }
      if (patch.preference !== undefined || patch.allowCloud !== undefined) {
        pool.routing = {
          ...pool.routing,
          ...(patch.preference !== undefined
            ? { preference: patch.preference }
            : {}),
          ...(patch.allowCloud !== undefined
            ? { allowCloud: patch.allowCloud }
            : {}),
        };
      }
      await this.deps.repository.write(doc);
      return pool;
    });
    this.emitChange();
    return updated;
  }

  async removePool(id: string): Promise<void> {
    await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      doc.pools = (doc.pools ?? []).filter((pool) => pool.id !== id);
      if (
        doc.selection?.scope.kind === "pool" &&
        doc.selection.scope.poolId === id
      ) {
        doc.selection.scope = { kind: "global", allowCloud: false };
      }
      await this.deps.repository.write(doc);
    });
    this.emitChange();
  }

  async getSelection(): Promise<ModelSelectionConfig | undefined> {
    return (await this.deps.repository.read()).selection;
  }

  async setSelection(config: ModelSelectionConfig): Promise<void> {
    await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      doc.selection = config;
      await this.deps.repository.write(doc);
    });
    this.emitChange();
  }

  async resolveRoute(
    input: Omit<RouteDecisionInput, "doc">,
  ): Promise<RouteDecision> {
    const doc = await this.deps.repository.read();
    return this.router.decide({ ...input, doc });
  }

  beginRequest(target: ModelTarget): () => void {
    return this.runtime.beginRequest(target);
  }

  recordFailure(
    target: { endpointId: string; modelId: string },
    error: FailureClass,
  ): void {
    this.runtime.recordFailure(target, error);
  }

  recordSuccess(
    target: { endpointId: string; modelId: string },
    latencyMs?: number,
    ttftMs?: number,
  ): void {
    this.runtime.recordSuccess(target, latencyMs, ttftMs);
  }

  async clearCredential(id: string): Promise<void> {
    const previousRef = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const ep = findEndpointOrThrow(doc, id);
      const prev = ep.credential;
      ep.credential = null;
      await this.deps.repository.write(doc);
      return prev;
    });

    await this.deps.credentials.delete(previousRef);
    this.emitChange();
  }

  async setDefault(id: string): Promise<void> {
    await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const ep = findEndpointOrThrow(doc, id);
      if (!ep.enabled) {
        throw new Error("Cannot make a disabled endpoint the default");
      }
      for (const item of doc.endpoints) {
        item.isDefault = item.id === id;
      }
      await this.deps.repository.write(doc);
    });

    this.emitChange();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const ep = findEndpointOrThrow(doc, id);
      ep.enabled = enabled;
      if (!enabled) {
        ep.isDefault = false;
      }
      await this.deps.repository.write(doc);
    });

    this.emitChange();
  }

  async setAssignment(
    task: TaskAssignment,
    endpointId: string,
    model: string,
  ): Promise<void> {
    await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      findEndpointOrThrow(doc, endpointId);
      doc.assignments[task] = { endpointId, model };
      await this.deps.repository.write(doc);
    });

    this.emitChange();
  }

  /**
   * Collapse duplicate endpoints that point at the same provider+baseUrl.
   * The canonical endpoint is the current default, or the first enabled one.
   * Assignments and defaults are migrated to canonical ids before removal.
   */
  async deduplicateByBaseUrl(): Promise<{ removed: string[] }> {
    const removed = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const groups = new Map<string, Endpoint[]>();
      for (const ep of doc.endpoints) {
        const key = endpointDedupKey(ep);
        const group = groups.get(key);
        if (group) group.push(ep);
        else groups.set(key, [ep]);
      }

      const toRemove = new Set<string>();
      const idMap = new Map<string, string>();
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const canonical =
          group.find((ep) => ep.isDefault) ??
          group.find((ep) => ep.enabled) ??
          group[0];
        for (const ep of group) {
          if (ep.id === canonical.id) continue;
          toRemove.add(ep.id);
          idMap.set(ep.id, canonical.id);
          for (const model of ep.models) {
            if (!canonical.models.some((m) => m.id === model.id)) {
              canonical.models.push(model);
            }
          }
          if (ep.credential && !canonical.credential) {
            canonical.credential = ep.credential;
          }
        }
        if (group.some((ep) => ep.isDefault)) canonical.isDefault = true;
      }

      if (toRemove.size === 0) return [] as string[];

      for (const task of [
        "default",
        "coding",
        "chat",
        "completion",
        "embedding",
      ] as const) {
        const assignment = doc.assignments[task];
        if (!assignment) continue;
        const mapped = idMap.get(assignment.endpointId);
        if (mapped) assignment.endpointId = mapped;
      }

      for (const pool of doc.pools ?? []) {
        pool.endpointIds = [
          ...new Set(
            pool.endpointIds.map(
              (endpointId) => idMap.get(endpointId) ?? endpointId,
            ),
          ),
        ];
      }
      const pinned = doc.selection?.pinned;
      if (pinned) {
        const mapped = idMap.get(pinned.endpointId);
        if (mapped) doc.selection!.pinned = { ...pinned, endpointId: mapped };
      }
      const endpointScope = doc.selection?.scope;
      if (endpointScope?.kind === "endpoint") {
        const mapped = idMap.get(endpointScope.endpointId);
        if (mapped)
          doc.selection!.scope = { kind: "endpoint", endpointId: mapped };
      }

      doc.endpoints = doc.endpoints.filter((ep) => !toRemove.has(ep.id));
      await this.deps.repository.write(doc);
      return [...toRemove];
    });

    if (removed.length > 0) this.emitChange();
    return { removed };
  }

  async resolveAssignment(
    task: TaskAssignment,
  ): Promise<{ endpoint: Endpoint; model: string } | null> {
    const doc = await this.deps.repository.read();
    const byId = new Map(doc.endpoints.map((ep) => [ep.id, ep]));

    const taskAssign = doc.assignments[task];
    if (taskAssign) {
      const ep = byId.get(taskAssign.endpointId);
      if (ep?.enabled) {
        return { endpoint: ep, model: taskAssign.model };
      }
    }

    const defaultAssign = doc.assignments.default;
    if (defaultAssign) {
      const ep = byId.get(defaultAssign.endpointId);
      if (ep?.enabled) {
        return { endpoint: ep, model: defaultAssign.model };
      }
    }

    const defaultEndpoint = doc.endpoints.find(
      (ep) => ep.enabled && ep.isDefault,
    );
    if (defaultEndpoint) {
      return {
        endpoint: defaultEndpoint,
        model: defaultModelForEndpoint(defaultEndpoint),
      };
    }

    const firstEnabled = doc.endpoints.find((ep) => ep.enabled);
    if (firstEnabled) {
      return {
        endpoint: firstEnabled,
        model: defaultModelForEndpoint(firstEnabled),
      };
    }

    return null;
  }

  async discover(id: string): Promise<DiscoveredModel[]> {
    const doc = await this.deps.repository.read();
    const ep = findEndpointOrThrow(doc, id);
    const secret = await this.deps.credentials.get(ep.credential);
    const models = await this.deps.discovery.discoverModels(
      ep,
      secret,
      this.discoveryDeps(),
    );

    if (models.length === 0) {
      return [];
    }

    await this.deps.repository.withLock(async () => {
      const freshDoc = await this.deps.repository.read();
      const target = findEndpointOrThrow(freshDoc, id);
      target.models = models;
      target.lastDiscoveredAt = this.deps.now();
      await this.deps.repository.write(freshDoc);
    });

    this.emitChange();
    return models;
  }

  async test(
    id: string,
    opts?: TestEndpointOptions,
  ): Promise<EndpointTestResult> {
    const doc = await this.deps.repository.read();
    const ep = findEndpointOrThrow(doc, id);
    const secret = await this.deps.credentials.get(ep.credential);
    return this.deps.discovery.testEndpoint(
      ep,
      secret,
      this.discoveryDeps(),
      opts,
    );
  }
}
