/**
 * Stable source ids and metadata for web-derived context.
 *
 * web_search registers results and fetch_url reuses the same id for the same
 * URL, so an answer can cite [S1] whether it used a snippet or the full page.
 */
export interface WebSource {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  /** ISO-8601 UTC timestamp, kept machine-readable in metadata. */
  retrievedAt: string;
}

export type WebSourceInput = Omit<WebSource, "id" | "domain"> & {
  domain?: string;
};

/** All timestamps shown to users are IST, never the browser/system timezone. */
export function formatIstTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    date.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " IST"
  );
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export class WebSourceRegistry {
  private readonly byUrl = new Map<string, WebSource>();
  private readonly ordered: WebSource[] = [];

  register(input: WebSourceInput): WebSource {
    const existing = this.byUrl.get(input.url);
    if (existing) return existing;
    const source: WebSource = {
      ...input,
      id: `S${this.ordered.length + 1}`,
      domain: input.domain ?? domainOf(input.url),
    };
    this.byUrl.set(source.url, source);
    this.ordered.push(source);
    return source;
  }

  list(): WebSource[] {
    return [...this.ordered];
  }

  get(id: string): WebSource | undefined {
    return this.ordered.find((source) => source.id === id);
  }

  /** Compact citation footer for tool output shown to the model and user. */
  formatCitations(sources: WebSource[] = this.ordered): string {
    if (sources.length === 0) return "";
    const lines = sources.map(
      (source) =>
        `[${source.id}] ${source.title} — ${source.domain} — ${source.url} (retrieved ${formatIstTimestamp(source.retrievedAt)})`,
    );
    return [
      "",
      "Citations: reference these sources as [S#] in your answer.",
      ...lines,
    ].join("\n");
  }
}
