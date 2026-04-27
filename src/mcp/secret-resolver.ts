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
    let resolved = value;
    for (const match of value.matchAll(SECRET_TOKEN)) {
      const secretKey = match[1];
      const secretValue = (await secretStorage.get(secretKey)) ?? "";
      // Use a replacer function so $ special chars in secretValue
      // (e.g. pa$$word) are not interpreted as replacement patterns.
      resolved = resolved.replace(match[0], () => secretValue);
    }
    result[key] = resolved;
  }

  return result;
}
