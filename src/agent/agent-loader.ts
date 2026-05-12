import * as fs from "fs/promises";
import * as path from "path";
import * as yaml from "js-yaml";
import type { CustomAgentDefinition } from "./agents/custom-agent";

export class AgentLoader {
  constructor(private readonly workspaceRoot: string) {}

  async loadAll(): Promise<CustomAgentDefinition[]> {
    const dir = path.join(this.workspaceRoot, ".champ", "agents");
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const defs: CustomAgentDefinition[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dir, entry);
      if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep))
        continue;
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const def = this.parse(raw, entry);
        if (def) defs.push(def);
      } catch (err) {
        console.warn(`Champ AgentLoader: skipping "${entry}":`, err);
      }
    }
    return defs;
  }

  private parse(raw: string, filename: string): CustomAgentDefinition | null {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)([\s\S]*)$/);
    if (!match) {
      console.warn(
        `Champ AgentLoader: "${filename}" missing frontmatter — skipping`,
      );
      return null;
    }
    const fm = yaml.load(match[1]) as Record<string, unknown>;
    const name = typeof fm.name === "string" ? fm.name.trim() : "";
    const role = typeof fm.role === "string" ? fm.role.trim() : "";
    if (!name || !role) {
      console.warn(
        `Champ AgentLoader: "${filename}" missing required name/role — skipping`,
      );
      return null;
    }
    const systemPrompt = (match[3] ?? "").trim();
    const outputKey =
      typeof fm.outputKey === "string" ? fm.outputKey.trim() : undefined;
    return { name, role, systemPrompt, outputKey };
  }
}
