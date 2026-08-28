/**
 * YAML merge-writer for guided setup (ticket #118).
 *
 * The wizard updates one provider block in .champ/config.yaml without
 * touching the rest of the file. The file is parsed and re-dumped with
 * js-yaml, so every other section and key is preserved verbatim; the only
 * trade-off is that comments are dropped from the output. Safe enough for a
 * wizard: the user seals the file after the run, and hand-edits after that
 * are left alone because the writer only rewrites on wizard runs.
 */
import * as yaml from "js-yaml";

export interface ProviderYamlPatch {
  /** Provider id, must match the key under `providers:` in config.yaml. */
  providerId: string;
  baseUrl?: string;
  model?: string;
  contextWindow?: number;
  options?: Record<string, unknown>;
}

export interface UpsertOptions {
  /** Also set the top-level `provider:` to the patched provider. */
  setActive?: boolean;
}

function cleanPatch(patch: ProviderYamlPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.baseUrl !== undefined) out.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.contextWindow !== undefined)
    out.contextWindow = patch.contextWindow;
  if (patch.options !== undefined && Object.keys(patch.options).length > 0) {
    out.options = patch.options;
  }
  return out;
}

/** True when the parsed config already has a block for this provider. */
export function providerExistsInYaml(
  text: string | null | undefined,
  providerId: string,
): boolean {
  if (!text?.trim()) return false;
  try {
    const parsed = yaml.load(text) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return false;
    const providers = parsed.providers as Record<string, unknown> | undefined;
    return Boolean(providers && providers[providerId]);
  } catch {
    return false;
  }
}

export function upsertProviderInYaml(
  text: string | null | undefined,
  patch: ProviderYamlPatch,
  opts: UpsertOptions = {},
): { yaml: string; created: boolean } {
  let root: Record<string, unknown>;
  let created = false;
  if (text?.trim()) {
    try {
      const parsed = yaml.load(text);
      root =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      // Untrusted/legacy content — start clean rather than clobber valid keys.
      root = {};
    }
  } else {
    root = {};
    created = true;
  }

  const providers =
    (root.providers as Record<string, unknown> | undefined) ?? {};
  const current =
    (providers[patch.providerId] as Record<string, unknown> | undefined) ?? {};
  providers[patch.providerId] = {
    ...current,
    ...cleanPatch(patch),
  };
  root.providers = providers;

  if (opts.setActive) root.provider = patch.providerId;

  return { yaml: yaml.dump(root), created };
}
