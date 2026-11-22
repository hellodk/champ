/**
 * Shared endpoint configuration service (`EndpointRegistry`) for CLI and extension.
 *
 * Owns endpoint CRUD, single-enabled-default invariants, task assignments,
 * onChange notifications, and credential-backed model discovery/testing.
 * Named `EndpointRegistry` (not `ProviderRegistry`) to avoid colliding with
 * the runtime LLM provider container in `src/providers/registry.ts`.
 */
import { randomUUID } from "crypto";
import type { CredentialStore } from "./credential-store";
import type {
  discoverModels,
  DiscoveryDeps,
  EndpointTestResult,
  testEndpoint,
} from "./model-discovery";
import { catalogEntry } from "./provider-catalog";
import {
  isProviderKind,
  type CredentialRef,
  type DiscoveredModel,
  type Endpoint,
  type ProviderKind,
  type ProvidersDocument,
  type TaskAssignment,
} from "./provider-model";
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

export class EndpointRegistry {
  private readonly deps: EndpointRegistryDeps;
  private readonly listeners = new Set<() => void>();

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
        models: [],
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

  async setCredential(id: string, secret: string): Promise<void> {
    const ref = await this.deps.repository.withLock(async () => {
      const doc = await this.deps.repository.read();
      const ep = findEndpointOrThrow(doc, id);
      if (ep.credential === null) {
        ep.credential = { kind: "keyring", id: ep.id };
        await this.deps.repository.write(doc);
      }
      return ep.credential;
    });

    await this.deps.credentials.set(ref, secret);
    this.emitChange();
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

  async test(id: string): Promise<EndpointTestResult> {
    const doc = await this.deps.repository.read();
    const ep = findEndpointOrThrow(doc, id);
    const secret = await this.deps.credentials.get(ep.credential);
    return this.deps.discovery.testEndpoint(ep, secret, this.discoveryDeps());
  }
}
