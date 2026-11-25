/**
 * Endpoint hygiene shared by the TUI and the CLI adapter.
 *
 * The registry can accumulate two rows for the same server (a manual add and
 * a discovered copy). Those rows must collapse to one canonical endpoint in
 * the UI, and the row must display the assigned model rather than whichever
 * discovered id happens to be first.
 */
import type { EndpointSummary } from "./state";

export interface TuiSelection {
  endpointId: string;
  model: string;
  stale: boolean;
}

export interface AssignmentRef {
  endpointId?: string;
  model?: string;
}

export function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

function endpointKey(endpoint: EndpointSummary): string {
  return `${endpoint.provider}|${normalizeBaseUrl(endpoint.baseUrl)}`;
}

/**
 * Collapse endpoints that share a provider and normalized base URL.
 * `preferredEndpointId` is normally the registry's assigned endpoint id, so
 * the canonical row is the one the user actually configured.
 */
export function dedupeEndpointSummaries(
  endpoints: EndpointSummary[],
  preferredEndpointId?: string,
): EndpointSummary[] {
  const groups = new Map<string, EndpointSummary[]>();
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint);
    const group = groups.get(key);
    if (group) group.push(endpoint);
    else groups.set(key, [endpoint]);
  }

  const result: EndpointSummary[] = [];
  for (const group of groups.values()) {
    const canonical =
      group.find((item) => item.id === preferredEndpointId) ?? group[0];
    const models = [...canonical.models];
    for (const item of group) {
      if (item.id === canonical.id) continue;
      for (const model of item.models) {
        if (!models.includes(model)) models.push(model);
      }
    }
    result.push({
      ...canonical,
      hasCredential:
        canonical.hasCredential || group.some((item) => item.hasCredential),
      models,
    });
  }
  return result;
}

/** Resolve which endpoint/model the TUI should show as active. */
export function resolveTuiSelection(
  endpoints: EndpointSummary[],
  currentEndpointId: string | undefined,
  assignment: AssignmentRef,
): TuiSelection {
  const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const endpoint =
    (assignment.endpointId ? byId.get(assignment.endpointId) : undefined) ??
    (currentEndpointId ? byId.get(currentEndpointId) : undefined) ??
    endpoints[0];

  if (!endpoint) {
    return {
      endpointId: assignment.endpointId ?? currentEndpointId ?? "",
      model: assignment.model ?? "",
      stale: Boolean(assignment.model),
    };
  }

  const requested = assignment.model;
  const hasRequested = Boolean(
    requested && endpoint.models.includes(requested),
  );
  // Keep the assigned model visible even when discovery has not listed it:
  // silently replacing it with a discovered id is what made the TUI show the
  // wrong model in the first place. The stale flag drives the re-pick prompt.
  const model = requested?.trim()
    ? requested.trim()
    : (endpoint.models[0] ?? "");
  return {
    endpointId: endpoint.id,
    model,
    stale: Boolean(requested) && !hasRequested,
  };
}
