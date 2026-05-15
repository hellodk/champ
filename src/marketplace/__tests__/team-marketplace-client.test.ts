import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TeamMarketplaceClient,
  type MarketplaceEntry,
} from "../team-marketplace-client";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => vi.clearAllMocks());

const SAMPLE: MarketplaceEntry[] = [
  {
    name: "devops",
    description: "DevOps team",
    author: "hellodk",
    url: "https://example.com/devops.yaml",
    tags: ["devops"],
  },
  {
    name: "fullstack",
    description: "Fullstack team",
    author: "hellodk",
    url: "https://example.com/fullstack.yaml",
    tags: ["frontend", "backend"],
  },
];

describe("TeamMarketplaceClient.fetchManifest", () => {
  it("returns parsed manifest on success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => SAMPLE });
    const entries = await new TeamMarketplaceClient().fetchManifest();
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("devops");
  });

  it("returns empty array on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect(await new TeamMarketplaceClient().fetchManifest()).toEqual([]);
  });

  it("returns empty array on non-ok status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    expect(await new TeamMarketplaceClient().fetchManifest()).toEqual([]);
  });

  it("uses custom URL when provided", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await new TeamMarketplaceClient(
      "https://custom.com/manifest.json",
    ).fetchManifest();
    expect(mockFetch).toHaveBeenCalledWith("https://custom.com/manifest.json");
  });
});

describe("TeamMarketplaceClient.downloadTeam", () => {
  it("saves YAML to destDir/name.yaml", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-test-"));
    const yaml = "name: devops\nagents: []\n";
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => yaml });
    const client = new TeamMarketplaceClient();
    const saved = await client.downloadTeam(
      {
        name: "devops",
        description: "",
        author: "",
        url: "https://example.com/devops.yaml",
        tags: [],
      },
      tmpDir,
    );
    expect(saved).toBe(path.join(tmpDir, "devops.yaml"));
    expect(await fs.readFile(saved, "utf8")).toBe(yaml);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });
    await expect(
      new TeamMarketplaceClient().downloadTeam(
        {
          name: "x",
          description: "",
          author: "",
          url: "https://example.com/x.yaml",
          tags: [],
        },
        "/tmp",
      ),
    ).rejects.toThrow(/403/);
  });
});
