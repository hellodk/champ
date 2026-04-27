import { describe, it, expect, vi } from "vitest";
import { resolveEnvSecrets } from "../../../src/mcp/secret-resolver";

function makeSecretStorage(secrets: Record<string, string | undefined>) {
  return {
    get: vi.fn(async (key: string) => secrets[key]),
  };
}

describe("resolveEnvSecrets", () => {
  it("returns env unchanged when no secret tokens present", async () => {
    const storage = makeSecretStorage({});
    const result = await resolveEnvSecrets(
      { PLAIN_KEY: "value" },
      storage as never,
    );
    expect(result).toEqual({ PLAIN_KEY: "value" });
  });

  it("replaces ${{ secrets.KEY }} with the stored secret", async () => {
    const storage = makeSecretStorage({ GITHUB_TOKEN: "ghp_abc123" });
    const result = await resolveEnvSecrets(
      { TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      storage as never,
    );
    expect(result).toEqual({ TOKEN: "ghp_abc123" });
  });

  it("leaves value as empty string when secret is not found", async () => {
    const storage = makeSecretStorage({});
    const result = await resolveEnvSecrets(
      { TOKEN: "${{ secrets.MISSING }}" },
      storage as never,
    );
    expect(result).toEqual({ TOKEN: "" });
  });

  it("handles multiple env vars independently", async () => {
    const storage = makeSecretStorage({ A: "aaa", B: "bbb" });
    const result = await resolveEnvSecrets(
      {
        KEY_A: "${{ secrets.A }}",
        KEY_B: "${{ secrets.B }}",
        PLAIN: "plain",
      },
      storage as never,
    );
    expect(result).toEqual({ KEY_A: "aaa", KEY_B: "bbb", PLAIN: "plain" });
  });

  it("handles whitespace inside token: ${{  secrets.MYKEY  }}", async () => {
    const storage = makeSecretStorage({ MYKEY: "secret" });
    const result = await resolveEnvSecrets(
      { X: "${{  secrets.MYKEY  }}" },
      storage as never,
    );
    expect(result).toEqual({ X: "secret" });
  });
});
