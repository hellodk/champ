import * as path from "path";
import * as fs from "fs/promises";

export interface MarketplaceEntry {
  name: string;
  description: string;
  author: string;
  url: string;
  tags: string[];
}

const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/manifest.json";

export class TeamMarketplaceClient {
  constructor(private readonly manifestUrl: string = DEFAULT_MANIFEST_URL) {}

  async fetchManifest(): Promise<MarketplaceEntry[]> {
    try {
      const res = await fetch(this.manifestUrl);
      if (!res.ok) return [];
      const data = (await res.json()) as MarketplaceEntry[];
      if (!Array.isArray(data)) return [];
      return data;
    } catch {
      return [];
    }
  }

  async downloadTeam(
    entry: MarketplaceEntry,
    destDir: string,
  ): Promise<string> {
    const res = await fetch(entry.url);
    if (!res.ok)
      throw new Error(
        `Failed to download team "${entry.name}": ${res.status} ${res.statusText}`,
      );
    const content = await res.text();
    await fs.mkdir(destDir, { recursive: true });
    const filePath = path.join(destDir, `${entry.name}.yaml`);
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }
}
