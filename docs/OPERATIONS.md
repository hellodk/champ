# Operations, Security & Publishing Guide

Development workflows, unified CLI operations, security checks (SAST/SCA/secrets/licenses), and extension release steps.

## Index

1. [Unified Project CLI (`scripts/champ`)](#unified-project-cli-scriptschamp)
2. [Development Commands](#development-commands)
3. [Observability Dashboard](#observability-dashboard)
4. [Security Checks (SAST, SCA, Secrets, Licenses)](#security-checks-sast-sca-secrets-licenses)
5. [Publishing (VS Code Marketplace & Open VSX)](#publishing-vs-code-marketplace--open-vsx)

---

## Unified Project CLI (`scripts/champ`)

```bash
scripts/champ                         # interactive menu
scripts/champ build                   # compile + package VSIX
scripts/champ install                 # install latest GitHub release VSIX
scripts/champ install build           # build checkout + install VSIX
scripts/champ release                 # build + push + create GitHub release
scripts/champ watch                   # dev watch (extension + webview)
scripts/champ test [unit|int|e2e|all|report]
scripts/champ lint                    # eslint + type-check
scripts/champ version                 # print package version
```

---

## Development Commands

```bash
pnpm install
pnpm run check-types
pnpm run lint
pnpm run test:unit                    # unit suite (vitest.config.ts)
pnpm run test:integration             # integration suite (vitest.integration.config.ts)
pnpm run test:e2e                     # e2e & packaging suite (vitest.e2e.config.ts)
pnpm run compile                      # typecheck + extension/CLI + webview + assets
node esbuild.mjs --production         # minified dist/extension.js & dist/cli.js
```

Note: `.npmignore` ships only `package.json`, `README.md`, `LICENSE`, and `dist/cli.js` in the npm CLI tarball (`prepack` builds `dist/cli.js`). `.vscodeignore` keeps `.champ/**`, `docs/**`, lockfiles, and build/report internals out of the `.vsix`.

---

## Observability Dashboard

Import [`grafana/champ-analytics-dashboard.json`](grafana/champ-analytics-dashboard.json) into Grafana and point Prometheus at ChampServer `/metrics` (authenticated with the `0600` bearer token from `~/.champ`).

---

## Security Checks (SAST, SCA, Secrets, Licenses)

### Local checks

```bash
pnpm audit --audit-level=high                     # dependency audit (prefer pnpm-lock.yaml)
osv-scanner --lockfile=pnpm-lock.yaml             # transitive CVE scan
semgrep --config=p/javascript --config=p/typescript --config=p/security-audit .
gitleaks detect --source . --verbose              # secret scan
npx license-checker --onlyAllow 'MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0;Python-2.0;Unlicense'
pnpm run lint && pnpm run check-types
```

### GitHub CI / Repo Settings

- Enable **Dependabot alerts & security updates** (`.github/dependabot.yml` targeting `npm` weekly).
- Enable **CodeQL** (`javascript-typescript` matrix in `.github/workflows/codeql.yml`).
- Enable **GitHub Secret Scanning** + **Push Protection** under repository security settings.
- Optional `.github/workflows/security.yml` running `pnpm audit`, `google/osv-scanner-action` on `pnpm-lock.yaml`, and `semgrep ci`.
- Protect `master` with required checks (`lint`, `typecheck`, `unit-tests`, `CodeQL`), PR review requirement, and stale review dismissal.

---

## Publishing (VS Code Marketplace & Open VSX)

### Pre-flight checklist

1. Ensure clean git tree, updated `package.json` version and `CHANGELOG.md`, present `LICENSE`, `README.md`, and $\ge$128×128 PNG at `media/icon.png` (use absolute URLs for README images).
2. Run full verification:
   ```bash
   pnpm run check-types && pnpm run lint && pnpm test && pnpm run package
   npx @vscode/vsce package --no-dependencies
   unzip -l champ-<version>.vsix | head -50   # verify dist/, webview-ui/dist/codicons/, media/icon.png; no node_modules or secrets
   code --install-extension ./champ-<version>.vsix --force
   ```

### Publish

- **VS Code Marketplace**: create Azure DevOps PAT (All accessible orgs, **Marketplace → Manage**), register matching publisher ID (`champ-oss`), login (`npx @vscode/vsce login <publisher>`), then `npx @vscode/vsce publish --no-dependencies` (or via `scripts/champ release` / tagged CI workflow pushing `v*`).
- **Open VSX** (VSCodium / Gitpod / Theia): create account & namespace at open-vsx.org, then `npx ovsx publish champ-<version>.vsix -p <OPEN_VSX_TOKEN>`.

### Telemetry & Privacy Rules

Respect `vscode.env.isTelemetryEnabled` and `champ.telemetry.enabled`; never transmit file contents, user names, or PII — only opaque hashes such as `vscode.env.machineId`.
