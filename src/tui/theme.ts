/**
 * Semantic colour roles for the Ink TUI.
 *
 * Components never choose hex values. They choose a role, and the active
 * palette maps that role to a colour appropriate for the terminal background.
 */
import * as fs from "fs";

export type ThemeName = "dark" | "light";

export type SemanticRole =
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "highlight"
  | "surface"
  | "text"
  | "border"
  | "panelTitle";

export type Palette = Record<SemanticRole, string>;

export const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    accent: "#7FB3FF",
    success: "#5ED49A",
    warning: "#F4C46B",
    error: "#FF8A8A",
    muted: "#AAB4C4",
    highlight: "#D7B4FF",
    surface: "#151A23",
    text: "#F3F6FA",
    border: "#3B4261",
    panelTitle: "#9AD9F5",
  },
  light: {
    accent: "#1558B0",
    success: "#137A46",
    warning: "#8A5A00",
    error: "#B4232C",
    muted: "#4B5563",
    highlight: "#6D3FBF",
    surface: "#FFFFFF",
    text: "#16202E",
    border: "#C4CCD8",
    panelTitle: "#1558B0",
  },
};

export type ThemeEnv = Record<string, string | undefined>;

/** Parse the reply to an OSC 11 terminal-background query. */
export function parseOsc11Response(input: string | null): ThemeName | null {
  if (!input) return null;
  const match = /\]11;rgb:([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})/i.exec(
    input,
  );
  if (!match) return null;
  const components = match.slice(1, 4).map((part) => {
    const value = Number.parseInt(part, 16) >> 8;
    return value;
  });
  const luminance =
    0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2];
  return luminance < 128 ? "dark" : "light";
}

function srgbChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = srgbChannel(Number.parseInt(value.slice(0, 2), 16));
  const g = srgbChannel(Number.parseInt(value.slice(2, 4), 16));
  const b = srgbChannel(Number.parseInt(value.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, used to keep every palette legible. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Resolve the theme synchronously. Explicit overrides win, then an OSC 11
 * reply, then environment fallbacks, then dark.
 */
export function resolveTheme(
  env: ThemeEnv,
  probeReply?: string | ThemeName | null,
  fallback: ThemeName = "dark",
): ThemeName {
  const explicit = env.CHAMP_THEME?.toLowerCase();
  if (explicit === "dark" || explicit === "light") return explicit;
  if (env.NO_COLOR && env.NO_COLOR !== "0") return "dark";
  if (env.FORCE_COLOR === "0") return "dark";

  const probed =
    probeReply === "dark" || probeReply === "light"
      ? probeReply
      : parseOsc11Response(probeReply ?? null);
  if (probed) return probed;

  const colorFgBg = env.COLORFGBG?.split(";");
  if (colorFgBg && colorFgBg.length >= 2) {
    const background = Number.parseInt(colorFgBg[1], 10);
    if (Number.isInteger(background))
      return background === 15 ? "light" : "dark";
  }
  if (env.TERM_PROGRAM) return "dark";
  return fallback;
}

/**
 * Ask the terminal for its background colour. The query and reply go through
 * /dev/tty so piped stdin is never consumed and CI output stays clean.
 */
export function probeTerminalBackground(
  timeoutMs = 150,
): Promise<string | null> {
  if (!process.stdout.isTTY || process.env.TERM === "dumb") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let fd: number;
    try {
      fd = fs.openSync("/dev/tty", "r+");
    } catch {
      resolve(null);
      return;
    }

    let buffer = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors from a terminal that already went away.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      fs.writeSync(fd, "\u001b]11;?\u001b\\");
      fs.read(fd, Buffer.alloc(256), 0, 256, null, (err, bytes, data) => {
        if (err || bytes === 0) {
          finish(null);
          return;
        }
        buffer += data.toString("utf8");
        if (buffer.includes("\u001b\\") || buffer.includes("\u0007")) {
          finish(buffer);
        } else {
          fs.read(fd, Buffer.alloc(256), 0, 256, null, () => finish(buffer));
        }
      });
    } catch {
      finish(null);
    }
  });
}

/** Async entry point used once, before the Ink renderer starts. */
export async function detectTheme(
  env: ThemeEnv = process.env,
): Promise<ThemeName> {
  const forced = env.CHAMP_THEME?.toLowerCase();
  if (forced === "dark" || forced === "light") return forced;
  return resolveTheme(env, await probeTerminalBackground());
}

/**
 * A `--theme` flag wins over CHAMP_THEME and terminal auto-detection. The CLI
 * adapter passes it through the runtime so the TUI stays free of argv parsing.
 */
export function resolveRuntimeTheme(
  runtime: { theme?: ThemeName },
  env: ThemeEnv = process.env,
): ThemeName {
  if (runtime.theme) return runtime.theme;
  return resolveTheme(env);
}

/** Build the environment used for async terminal-background detection. */
export function themeEnvForRuntime(
  runtime: { theme?: ThemeName },
  env: ThemeEnv = process.env,
): ThemeEnv {
  return runtime.theme ? { ...env, CHAMP_THEME: runtime.theme } : env;
}
