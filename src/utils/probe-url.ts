/**
 * Connectivity-probe URL construction shared by loadProvider's
 * reachability check.
 *
 * Bug history: the probe appended "/v1/models" to raw baseUrls, producing
 * /v1/v1/models for correctly-configured servers (404 -> "provider not
 * ready"), while missing-/v1 configs only worked by accident of that same
 * append. Normalise here.
 */

const PROVIDER_ENDPOINTS: Record<string, string> = {
  ollama: "/api/tags",
  llamacpp: "/models",
  vllm: "/models",
  "openai-compatible": "/models",
};

export function buildProbeUrl(baseUrl: string, providerName: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const endpoint = PROVIDER_ENDPOINTS[providerName] ?? "/models";
  if (providerName === "ollama") {
    return `${base}${endpoint}`;
  }
  return `${base}/v1${endpoint}`;
}
