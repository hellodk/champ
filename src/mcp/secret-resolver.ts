import type * as vscode from "vscode";

const SECRET_TOKEN = /\${{\s*secrets\.(\w+)\s*}}/g;

/**
 * Resolve `${{ secrets.KEY }}` tokens in MCP server env values using
 * VS Code SecretStorage. Values without tokens are returned unchanged.
 * Unknown keys resolve to empty string (avoids leaking that the key exists).
 */
export async function resolveEnvSecrets(
  env: Record<string, string>,
  secretStorage: Pick<vscode.SecretStorage, "get">,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_TOKEN.test(value)) {
      // Reset lastIndex after test() on a global regex.
      SECRET_TOKEN.lastIndex = 0;
      result[key] = value;
      continue;
    }

    SECRET_TOKEN.lastIndex = 0;

    let resolved = value;
    const matches = [...value.matchAll(SECRET_TOKEN)];
    for (const match of matches) {
      const secretKey = match[1];
      const secretValue = (await secretStorage.get(secretKey)) ?? "";
      resolved = resolved.replace(match[0], secretValue);
    }
    result[key] = resolved;
  }

  return result;
}
