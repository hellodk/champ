/**
 * Resolve the package-manager command for E2E packaging tests.
 *
 * CI installs pnpm with pnpm/action-setup, so using the binary from PATH avoids
 * Corepack's network lookup. A Corepack fallback keeps plain developer shells
 * working, but only when the project manifest is available to pin the version.
 */
import { statSync } from "node:fs";
import * as path from "node:path";

export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

export function pnpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): [string, ...string[]] {
  const pnpm = findOnPath("pnpm", env, platform);
  if (pnpm) return [pnpm];

  const corepack = findOnPath("corepack", env, platform);
  if (corepack) return [corepack, "pnpm"];

  throw new Error(
    "pnpm was not found on PATH and Corepack is unavailable. Install pnpm or enable Corepack.",
  );
}
