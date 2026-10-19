/**
 * End-to-end packaging tests for the headless CLI — issue #139.
 *
 * The deliverable is the tarball a Mac Mini installs, so these tests measure
 * the tarball itself: exactly what `npm pack` puts in it, that the extracted
 * bundle runs with no VS Code and no `node_modules` around it, and that a real
 * `npm install -g` of it yields a working `champ` command.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCli } from "../helpers/cli-harness";

const ROOT = path.resolve(__dirname, "../..");
const TIMEOUT = 180_000;

/** The published payload: the standalone bundle, manifest, licence and readme. */
const EXPECTED_FILES = ["LICENSE", "README.md", "dist/cli.js", "package.json"];

/** Never allowed inside the tarball: repo internals and user/team state. */
const FORBIDDEN_PREFIXES = [
  "src/",
  "test/",
  "docs/",
  "webview-ui/",
  ".champ/",
  ".github/",
  ".husky/",
  ".vscode/",
  "dist/extension.js",
  "dist/scripts/",
];

let tmp = "";
let tarball = "";
let packedFiles: string[] = [];
let extracted = "";

function manifestVersion(): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "unknown";
}

beforeAll(async () => {
  await buildCli();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "champ-pack-"));
  const packDir = path.join(tmp, "packed");
  fs.mkdirSync(packDir, { recursive: true });

  const raw = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    { cwd: ROOT, encoding: "utf8" },
  );
  const report = JSON.parse(raw) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  tarball = path.join(packDir, report[0].filename);
  packedFiles = report[0].files.map((f) => f.path).sort();

  extracted = path.join(tmp, "extracted");
  fs.mkdirSync(extracted, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
}, TIMEOUT);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("champ CLI packaging (#139)", () => {
  it("ships exactly the CLI payload", () => {
    expect(packedFiles).toEqual(EXPECTED_FILES);
  });

  it("leaves repo internals and user state out of the tarball", () => {
    const leaked = packedFiles.filter((file) =>
      FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
    expect(leaked).toEqual([]);
  });

  it("extracts to a bundle that runs with no VS Code and no node_modules", () => {
    const pkgDir = path.join(extracted, "package");
    const cli = path.join(pkgDir, "dist", "cli.js");

    expect(fs.existsSync(cli)).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "node_modules"))).toBe(false);
    // The executable bit has to survive packing and extraction, or `bin`
    // installs produce a command that cannot be run.
    expect(fs.statSync(cli).mode & 0o111).not.toBe(0);

    const version = execFileSync(process.execPath, [cli, "--version"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(version.trim()).toBe(`champ ${manifestVersion()}`);

    // Read-only workspace query with no config anywhere: the installed layout
    // finds its own manifest and needs no repository around it.
    const sessions = execFileSync(process.execPath, [cli, "--sessions"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, CHAMP_CONFIG: path.join(tmp, "absent.yaml") },
    });
    expect(sessions).toContain("no sessions in");
  });

  it("installs globally and exposes a working champ bin", () => {
    const prefix = path.join(tmp, "prefix");
    execFileSync(
      "npm",
      [
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        tarball,
      ],
      { cwd: tmp, encoding: "utf8" },
    );

    const bin = path.join(prefix, "bin", "champ");
    expect(fs.existsSync(bin)).toBe(true);

    const version = execFileSync(bin, ["--version"], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, CHAMP_CONFIG: path.join(tmp, "absent.yaml") },
    });
    expect(version.trim()).toBe(`champ ${manifestVersion()}`);
  });
});
