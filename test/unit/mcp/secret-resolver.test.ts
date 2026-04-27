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

  it("handles mixed token+literal: 'Bearer ${{ secrets.TOKEN }}'", async () => {
    const storage = makeSecretStorage({ TOKEN: "tok123" });
    const result = await resolveEnvSecrets(
      { AUTH: "Bearer ${{ secrets.TOKEN }}" },
      storage as never,
    );
    expect(result).toEqual({ AUTH: "Bearer tok123" });
  });

  it("does not corrupt secret values containing $ special chars", async () => {
    const storage = makeSecretStorage({ PASS: "pa$$word" });
    const result = await resolveEnvSecrets(
      { PWD: "${{ secrets.PASS }}" },
      storage as never,
    );
    expect(result).toEqual({ PWD: "pa$$word" });
  });

  it("resolves two different tokens in the same value", async () => {
    const storage = makeSecretStorage({ USER: "alice", HOST: "db.local" });
    const result = await resolveEnvSecrets(
      { DSN: "postgres://${{ secrets.USER }}@${{ secrets.HOST }}/mydb" },
      storage as never,
    );
    expect(result).toEqual({ DSN: "postgres://alice@db.local/mydb" });
  });

  it("resolves the same token appearing twice in one value", async () => {
    const storage = makeSecretStorage({ TOKEN: "abc" });
    const result = await resolveEnvSecrets(
      { DUAL: "${{ secrets.TOKEN }}/${{ secrets.TOKEN }}" },
      storage as never,
    );
    expect(result).toEqual({ DUAL: "abc/abc" });
  });
});
