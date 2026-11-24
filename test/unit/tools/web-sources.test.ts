/**
 * Web citations: stable [S#] ids, IST timestamps and a compact citation footer.
 */
import { describe, it, expect } from "vitest";
import {
  WebSourceRegistry,
  domainOf,
  formatIstTimestamp,
} from "@/tools/web-sources";

const AT = "2026-06-02T11:00:45.000Z"; // 16:30:45 IST

describe("domainOf", () => {
  it("strips www and handles invalid urls", () => {
    expect(domainOf("https://www.example.com/a")).toBe("example.com");
    expect(domainOf("not a url")).toBe("unknown");
  });
});

describe("formatIstTimestamp", () => {
  it("renders absolute UTC timestamps in IST", () => {
    expect(formatIstTimestamp(AT)).toBe("02 Jun 2026, 16:30:45 IST");
  });

  it("passes through unparseable values", () => {
    expect(formatIstTimestamp("nope")).toBe("nope");
  });
});

describe("WebSourceRegistry", () => {
  const input = (url: string, title = "Doc") => ({
    title,
    url,
    snippet: "snippet",
    retrievedAt: AT,
  });

  it("assigns sequential ids and reuses them for the same url", () => {
    const registry = new WebSourceRegistry();
    const first = registry.register(input("https://a.dev/docs"));
    const second = registry.register(input("https://b.dev/docs", "Other"));
    const again = registry.register(input("https://a.dev/docs", "Renamed"));

    expect(first.id).toBe("S1");
    expect(second.id).toBe("S2");
    expect(again).toBe(first);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("S1")?.title).toBe("Doc");
  });

  it("formats a citation footer in IST", () => {
    const registry = new WebSourceRegistry();
    const source = registry.register(input("https://example.com/a"));
    const footer = registry.formatCitations([source]);
    expect(footer).toContain("[S1] Doc — example.com — https://example.com/a");
    expect(footer).toContain("02 Jun 2026, 16:30:45 IST");
    expect(footer).toContain("reference these sources as [S#]");
  });

  it("returns an empty footer when there are no sources", () => {
    expect(new WebSourceRegistry().formatCitations()).toBe("");
  });
});
