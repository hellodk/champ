import { describe, it, expect, vi, afterEach } from "vitest";
import { TeamMarketplaceClient } from "../team-marketplace-client";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
afterEach(() => vi.clearAllMocks());

describe("TeamMarketplaceClient e2e", () => {
  it("full flow: fetchManifest → downloadTeam → file exists", async () => {
    const manifest = [
      {
        name: "ci-bot",
        description: "CI bot",
        author: "test",
        url: "https://example.com/ci-bot.yaml",
        tags: ["ci"],
      },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => manifest })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "name: ci-bot\nagents: []\n",
      });
    const client = new TeamMarketplaceClient();
    const entries = await client.fetchManifest();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-e2e-"));
    const saved = await client.downloadTeam(entries[0], tmpDir);
    expect(await fs.readFile(saved, "utf8")).toBe("name: ci-bot\nagents: []\n");
    await fs.rm(tmpDir, { recursive: true });
  });

  it("returns [] on network failure", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await new TeamMarketplaceClient().fetchManifest()).toEqual([]);
  });
});
