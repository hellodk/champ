/**
 * URL + optional API key onboarding.
 *
 * Protocol detection is based on the endpoint's native model-list API and the
 * response shape it returns. Credentials are only sent to the origin the user
 * entered; a cross-origin redirect is followed without them.
 */
import { randomUUID } from "crypto";
import {
  parseGeminiModels,
  parseOllamaTags,
  parseOpenAIModels,
  type DiscoveryDeps,
} from "./model-discovery";
import type { DiscoveredModel, Endpoint, ProviderKind } from "./provider-model";

export type OnboardingProtocol =
  | "ollama"
  | "openai-compatible"
  | "anthropic"
  | "gemini";

export interface OnboardInput {
  url: string;
  apiKey?: string;
  name?: string;
  id?: string;
  manualModelIds?: string[];
}

export interface OnboardingResult {
  protocol: OnboardingProtocol;
  endpoint: Endpoint;
  models: DiscoveredModel[];
  warnings: string[];
  error?: string;
}

export interface UrlValidation {
  ok: boolean;
  url?: URL;
  error?: string;
}

const CREDENTIAL_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
];

function privateHttpHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    !hostname.includes(".")
  ) {
    return true;
  }
  if (/^127\./.test(hostname) || /^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  const private172 = hostname.match(/^172\.(\d+)\./);
  return (
    !!private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31
  );
}

export function validateEndpointUrl(raw: string): UrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Invalid endpoint URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Endpoint URL must use http or https" };
  }
  if (parsed.protocol === "http:" && !privateHttpHost(parsed.hostname)) {
    return {
      ok: false,
      error: "Plain HTTP is only allowed for localhost, loopback and LAN hosts",
    };
  }
  return { ok: true, url: parsed };
}

function stripCredentials(
  headers: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.includes(name.toLowerCase())) clean[name] = value;
  }
  return clean;
}

async function fetchJson(
  url: URL,
  headers: Record<string, string>,
  deps: DiscoveryDeps,
  signal?: AbortSignal,
): Promise<{
  payload?: unknown;
  error?: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const timeoutMs = deps.requestTimeoutMs ?? 5_000;
  let current = url;
  let activeHeaders = headers;

  for (let hop = 0; hop < 3; hop++) {
    if (signal?.aborted) return { error: "cancelled", warnings };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        deps.fetch(current.toString(), {
          method: "GET",
          headers: activeHeaders,
          redirect: "manual",
          signal: controller.signal,
        }),
        timeout,
      ]);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return {
            error: "Redirect response had no Location header",
            warnings,
          };
        }
        const next = new URL(location, current);
        if (next.protocol !== "https:" && next.protocol !== "http:") {
          return { error: "Redirect uses an unsupported protocol", warnings };
        }
        if (next.origin !== current.origin) {
          warnings.push(
            "cross-origin redirect detected; credentials were not forwarded",
          );
          activeHeaders = stripCredentials(headers);
        }
        current = next;
        continue;
      }

      if (!response.ok) {
        return { error: `HTTP ${response.status}`, warnings };
      }
      try {
        return { payload: await response.json(), warnings };
      } catch {
        return { error: "Endpoint returned invalid JSON", warnings };
      }
    } catch (err) {
      if (signal?.aborted) return { error: "cancelled", warnings };
      return {
        error: err instanceof Error ? err.message : String(err),
        warnings,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return { error: "Too many redirects", warnings };
}

function probeUrl(baseUrl: string, protocol: OnboardingProtocol): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (protocol === "ollama") {
    return `${trimmed.replace(/\/v1$/, "")}/api/tags`;
  }
  if (protocol === "gemini") {
    const base = /\/v1beta$/i.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
    return `${base}/models`;
  }
  const base = /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return `${base}/models`;
}

function probeHeaders(
  protocol: OnboardingProtocol,
  apiKey: string | undefined,
): Record<string, string> {
  if (!apiKey) return {};
  if (protocol === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  if (protocol === "gemini") return { "x-goog-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

function parseProbe(
  protocol: OnboardingProtocol,
  payload: unknown,
  seenAt: string,
): DiscoveredModel[] {
  if (protocol === "ollama") return parseOllamaTags(payload, seenAt);
  if (protocol === "gemini") return parseGeminiModels(payload, seenAt);
  return parseOpenAIModels(payload, seenAt);
}

function providerForProtocol(protocol: OnboardingProtocol): ProviderKind {
  if (protocol === "ollama") return "ollama";
  if (protocol === "anthropic") return "claude";
  if (protocol === "gemini") return "gemini";
  return "openai-compatible";
}

function manualModels(ids: string[]): DiscoveredModel[] {
  return ids
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({
      id,
      capabilitySet: {
        chat: "unknown" as const,
        tools: "unknown" as const,
        embeddings: "unknown" as const,
        images: "unknown" as const,
        structuredOutput: "unknown" as const,
      },
    }));
}

function protocolOrder(url: URL): OnboardingProtocol[] {
  const host = url.hostname.toLowerCase();
  if (host.includes("anthropic")) return ["anthropic"];
  if (host.includes("generativelanguage")) return ["gemini"];
  if (url.pathname.includes("/v1")) {
    return ["openai-compatible"];
  }
  return ["ollama", "openai-compatible"];
}

export async function onboardEndpoint(
  input: OnboardInput,
  deps: DiscoveryDeps,
): Promise<OnboardingResult> {
  const validation = validateEndpointUrl(input.url);
  const baseUrl = input.url.trim();
  const id = input.id?.trim() || `ep_${randomUUID().slice(0, 8)}`;
  const warnings: string[] = [];
  const manual = manualModels(input.manualModelIds ?? []);
  const empty = (
    protocol: OnboardingProtocol,
    error?: string,
  ): OnboardingResult => ({
    protocol,
    endpoint: {
      id,
      name: input.name?.trim() || `${protocol} endpoint`,
      provider: providerForProtocol(protocol),
      baseUrl,
      credential: input.apiKey ? { kind: "keyring", id } : null,
      enabled: true,
      isDefault: false,
      models: manual,
      options: { onboardingProtocol: protocol },
    },
    models: manual,
    warnings,
    ...(error !== undefined ? { error } : {}),
  });

  if (!validation.ok || !validation.url) {
    return empty(
      "openai-compatible",
      validation.error ?? "Invalid endpoint URL",
    );
  }
  if (validation.url.protocol === "http:" && input.apiKey) {
    warnings.push(
      "API credential will be sent over plaintext HTTP; use HTTPS for remote endpoints",
    );
  }
  if (deps.signal?.aborted) return empty("openai-compatible", "cancelled");

  const seenAt = deps.now();
  const errors: string[] = [];
  for (const protocol of protocolOrder(validation.url)) {
    const result = await fetchJson(
      new URL(probeUrl(baseUrl, protocol)),
      probeHeaders(protocol, input.apiKey?.trim() || undefined),
      deps,
      deps.signal,
    );
    warnings.push(...result.warnings);
    if (result.error) {
      errors.push(`${protocol}: ${result.error}`);
      continue;
    }
    const models = parseProbe(protocol, result.payload, seenAt);
    if (models.length === 0) {
      errors.push(`${protocol}: no models found in response`);
      continue;
    }
    return {
      protocol,
      endpoint: {
        id,
        name: input.name?.trim() || `${protocol} endpoint`,
        provider: providerForProtocol(protocol),
        baseUrl,
        credential: input.apiKey ? { kind: "keyring", id } : null,
        enabled: true,
        isDefault: false,
        models,
        lastDiscoveredAt: seenAt,
        options: { onboardingProtocol: protocol },
      },
      models,
      warnings,
    };
  }

  return empty(
    "openai-compatible",
    `No recognisable model list (${errors.join("; ")})`,
  );
}
