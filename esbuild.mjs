import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode', 'playwright-core', 'chromium-bidi'],
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

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
