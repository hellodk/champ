/**
 * Shared SSRF guard for tools that navigate to LLM-supplied URLs.
 *
 * Single source of truth for "may this process talk to this URL?".
 * Blocks non-http(s) schemes, loopback hosts (*.localhost, localhost),
 * mDNS names (*.local) and private/link-local IP literals, so neither
 * the browser tool nor fetch_url can be pointed at internal services,
 * cloud metadata endpoints, or the local filesystem.
 */

export type UrlGuardResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const PRIVATE_MSG =
  "Fetching internal/private network addresses is not allowed";

/** Matches exact blocked IPv4 literals AND hostnames that embed one as a prefix (e.g. 127.0.0.1.nip.io). */
function ipv4RangeLabel(host: string): string | null {
  if (/^127(\.|$)/.test(host)) return "an IPv4 loopback address (127.0.0.0/8)";
  if (/^10(\.|$)/.test(host)) return "a private IPv4 address (10.0.0.0/8)";
  if (/^192\.168(\.|$)/.test(host))
    return "a private IPv4 address (192.168.0.0/16)";
  if (/^169\.254(\.|$)/.test(host))
    return "a link-local IPv4 address (169.254.0.0/16)";
  if (/^172\.(1[6-9]|2\d|3[01])(\.|$)/.test(host))
    return "a private IPv4 address (172.16.0.0/12)";
  if (/^0(\.|$)/.test(host)) return "an unspecified IPv4 address (0.0.0.0/8)";
  return null;
}

function ipv6RangeLabel(host: string): string | null {
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (!bare.includes(":")) return null;

  const lower = bare.toLowerCase();

  // IPv4-mapped tails (::ffff:127.0.0.1) fall back to the IPv4 rules.
  const lastGroup = lower.split(":").pop() ?? "";
  if (lastGroup.includes(".")) {
    const label = ipv4RangeLabel(lastGroup);
    return label ? `${label}, embedded in IPv6 "${host}"` : null;
  }

  if (lower === "::1" || lower === "::")
    return "an IPv6 loopback address (::1)";

  const firstGroup = (lower.split(":")[0] ?? "").padStart(4, "0");
  if (/^f[cd]/.test(firstGroup))
    return "a unique-local IPv6 address (fc00::/7)";
  if (/^fe[89ab]/.test(firstGroup))
    return "a link-local IPv6 address (fe80::/10)";

  return null;
}

export function validatePublicHttpUrl(raw: string): UrlGuardResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `Invalid URL "${raw}"` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Only http:// and https:// URLs are allowed (got "${parsed.protocol}")`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { ok: false, reason: `${PRIVATE_MSG}: URL has no hostname` };
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return {
      ok: false,
      reason: `${PRIVATE_MSG}: "${hostname}" is a loopback (localhost) address`,
    };
  }

  if (hostname.endsWith(".local")) {
    return {
      ok: false,
      reason: `${PRIVATE_MSG}: "${hostname}" uses the reserved ".local" mDNS suffix`,
    };
  }

  const ipv4Label = ipv4RangeLabel(hostname);
  if (ipv4Label) {
    return {
      ok: false,
      reason: `${PRIVATE_MSG}: "${hostname}" is ${ipv4Label}`,
    };
  }

  const ipv6Label = ipv6RangeLabel(parsed.hostname);
  if (ipv6Label) {
    return {
      ok: false,
      reason: `${PRIVATE_MSG}: "${parsed.hostname}" is ${ipv6Label}`,
    };
  }

  return { ok: true, url: raw };
}
