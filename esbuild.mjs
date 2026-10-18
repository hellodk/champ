import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  logLevel: 'info',
  target: 'node20',
  // Redirect polyfill packages to native Node 20 globals.
  // Removes ~500KB: node-fetch + tr46 + whatwg-url + web-streams-polyfill +
  // formdata-node + abort-controller + event-target-shim.
  alias: {
    'node-fetch': './shims/node-fetch.cjs',
    'formdata-node': './shims/formdata-node/index.cjs',
    'formdata-node/file-from-path': './shims/formdata-node/file-from-path.cjs',
    'abort-controller': './shims/abort-controller.cjs',
  },
};

const extensionOptions = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode', 'playwright-core', 'chromium-bidi'],
};

// Headless entry (issue #136). Deliberately built WITHOUT `vscode` in
// `external`: the CLI must run outside VS Code, so an accidental vscode
// import fails here at build time instead of throwing `require("vscode")`
// on a machine that has no VS Code at all.
const cliOptions = {
  ...shared,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  external: ['playwright-core', 'chromium-bidi'],
  banner: { js: '#!/usr/bin/env node' },
};

async function run(options) {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}

async function main() {
  // Both entries must build; run them concurrently but fail the process if
  // either fails.
  await Promise.all([run(extensionOptions), run(cliOptions)]);
  // npm sets +x for `bin` installs; do the same for the local artifact so
  // `./dist/cli.js` works without an explicit `node`.
  fs.chmodSync('dist/cli.js', 0o755);
  if (watch) console.log('Watching for changes...');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
