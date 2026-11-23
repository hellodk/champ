/**
 * Single resolver for the user-level Champ home directory.
 *
 * `CHAMP_HOME` overrides `os.homedir()` so headless runs, CI and tests can use
 * an isolated `~/.champ` without touching the developer's endpoints, secrets,
 * settings or index cache. When it is absent or blank, behaviour is unchanged.
 */
import * as os from "os";
import * as path from "path";

export function champHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CHAMP_HOME;
  return override && override.trim() ? path.resolve(override) : os.homedir();
}

/** Absolute path of the canonical `.champ` directory. */
export function champConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(champHome(env), ".champ");
}
