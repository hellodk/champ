# Security Checks: SAST, SCA, and GitHub Configuration

This document lists recommended security checks (SAST, SCA, secrets, container, license, etc.) for this project, how to run them locally, and how to configure them in GitHub (Actions, Dependabot, Code Scanning).

## Table of Contents

- [Quick checklist](#quick-checklist)
- [Recommended checks](#recommended-checks)
- [Local setup and running](#local-setup-and-running)
- [GitHub configuration](#github-configuration)
- [Notes for this repo](#notes-for-this-repo)
- [References](#references)

---

## Quick checklist

- [ ] **SCA (dependency scanning)**: Enable Dependabot alerts, Dependabot security updates, and optionally `npm audit` / OSV-Scanner
- [ ] **SAST (static analysis)**: Enable CodeQL (GitHub Advanced Security) or Semgrep
- [ ] **Secrets scanning**: Enable GitHub secret scanning + push protection
- [ ] **License compliance**: Review dependencies for license compatibility
- [ ] **Supply chain**: Consider `npm provenance` (if publishing), lockfile integrity checks
- [ ] **Linting/security rules**: Ensure ESLint security rules are enabled
- [ ] **Container/IaC** (if applicable): Not present in this repo currently

---

## Recommended checks

| Category | Tool (free) | What it catches | Where to run |
|----------|--------------|-----------------|--------------|
| **SCA** | [npm audit](https://docs.npmjs.com/cli/v9/commands/npm-audit) | Known vulns in npm deps | Local + CI |
| **SCA** | [Dependabot](https://docs.github.com/en/code-security/dependabot) | Alerts, auto-PRs for vulns/upgrades | GitHub |
| **SCA** | [OSV-Scanner](https://github.com/google/osv-scanner) | Broader ecosystem vulns (transitive) | Local + CI |
| **SAST** | [CodeQL](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql) | JS/TS code issues (injection, XSS, etc.) | GitHub Code Scanning |
| **SAST** | [Semgrep](https://semgrep.dev/) | Fast, customizable rules; many free rulesets | Local + CI |
| **Secrets** | [GitHub Secret Scanning](https://docs.github.com/en/code-security/secret-scanning) | Leaked tokens/keys | GitHub (push protection recommended) |
| **Secrets** | [gitleaks](https://github.com/gitleaks/gitleaks) | Pre-commit/local secret detection | Local/pre-commit |
| **License** | [license-checker](https://github.com/davglass/license-checker) or [FOSSA](https://fossa.com/) | License compliance | Local/CI |
| **Type/quality** | [ESLint](https://eslint.org/) (with security plugins) | Code quality + some security patterns | Local/CI (already used) |

---

## Local setup and running

### Prerequisites
```bash
# Node/pnpm as in repo
pnpm install
```

### SCA
```bash
# npm audit (built-in)
pnpm audit --audit-level=high

# OSV-Scanner (install separately)
# macOS: brew install osv-scanner
# Linux: see https://github.com/google/osv-scanner#installation
osv-scanner --lockfile=pnpm-lock.yaml
# or for package-lock if present
osv-scanner --lockfile=package-lock.json
```

### SAST
```bash
# Semgrep (quick scan)
# Install: pipx install semgrep OR npm i -g @semgrep/cli
semgrep --config=auto --error .

# Or use specific rulesets
semgrep --config=p/javascript --config=p/typescript --config=p/security-audit .
```

### Secrets detection
```bash
# gitleaks
# Install: brew install gitleaks or go install
gitleaks detect --source . --verbose

# Pre-commit hook (optional)
# Add to .husky/pre-commit or use pre-commit framework
```

### License check
```bash
# license-checker
npx license-checker --summary
npx license-checker --onlyAllow 'MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0;Python-2.0;Unlicense'
```

### Linting (already configured)
```bash
pnpm run lint
pnpm run check-types
```

---

## GitHub configuration

### 1) Dependabot (SCA)
Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
    groups:
      dev-dependencies:
        patterns:
          - "*"
        dependency-type: "development"
```

Then in GitHub: `Settings > Security > Code security and analysis` enable:
- **Dependabot alerts** (on)
- **Dependabot security updates** (on)
- **Grouped security updates** (recommended)

### 2) CodeQL (SAST)
GitHub can generate a workflow. In repo root create `.github/workflows/codeql.yml`:

```yaml
name: "CodeQL"

on:
  push:
    branches: [ "master" ]
  pull_request:
    branches: [ "master" ]
  schedule:
    - cron: '0 3 * * 1'  # weekly

jobs:
  analyze:
    name: Analyze
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write

    strategy:
      fail-fast: false
      matrix:
        language: [ 'javascript-typescript' ]

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}

      - name: Autobuild
        uses: github/codeql-action/autobuild@v3

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:${{ matrix.language }}"
```

Or use `Settings > Security > Code security and analysis > Code scanning > Set up > Advanced` to generate it.

### 3) Secret scanning + push protection
In GitHub: `Settings > Security > Code security and analysis`
- Enable **Secret scanning**
- Enable **Push protection** (blocks commits with secrets)

### 4) Add security workflow (npm audit + OSV + Semgrep)
Create `.github/workflows/security.yml`:

```yaml
name: Security Checks

on:
  push:
    branches: [ "master" ]
  pull_request:
    branches: [ "master" ]
  schedule:
    - cron: '0 4 * * 1'

jobs:
  npm-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --audit-level=high || true

  osv-scanner:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run OSV-Scanner
        uses: google/osv-scanner-action@v1
        with:
          scan-args: |-
            --lockfile=pnpm-lock.yaml

  semgrep:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep
    steps:
      - uses: actions/checkout@v4
      - run: semgrep ci
        env:
          SEMGREP_APP_TOKEN: ${{ secrets.SEMGREP_APP_TOKEN }}
```

**Note:** For Semgrep CI, you can run without `SEMGREP_APP_TOKEN` for basic scanning (`semgrep ci` will still scan). If you want to upload to Semgrep App, add the token.

### 5) Branch protection (recommended)
In `Settings > Branches > Branch protection rules` for `master`:
- Require status checks to pass (add `lint`, `typecheck`, `unit-tests`, `CodeQL`, `Security Checks`)
- Require pull request reviews
- Dismiss stale reviews
- Require conversation resolution
- Do not allow bypassing

---

## Notes for this repo

- **Package manager**: Uses `pnpm` (see `packageManager` in package.json). Use `pnpm audit`, not `npm audit` if possible.
- **Lockfiles**: Both `pnpm-lock.yaml` and `package-lock.json` exist. Prefer scanning `pnpm-lock.yaml` for consistency.
- **CI exists**: `.github/workflows/ci.yml` runs lint, typecheck, unit-tests. Add security workflows separately.
- **No Dockerfile/IaC**: Current security focus should be on dependencies and code (SAST/SCA/secrets).
- **VS Code extension**: SAST/SCA still apply to source code and dependencies.
- **Secrets in repo**: `.champ/` is gitignored; be careful not to commit config with real keys. Secret scanning will help.
- **ESLint**: Already configured via `eslint.config.mjs` - consider adding `eslint-plugin-security` for stronger rules.

---

## References

- [GitHub Security Documentation](https://docs.github.com/en/code-security)
- [OWASP Dependency-Check](https://owasp.org/www-project-dependency-check/)
- [npm audit docs](https://docs.npmjs.com/cli/v9/commands/npm-audit)
- [OSV.dev](https://osv.dev/)
- [Semgrep Rules](https://semgrep.dev/explore)
- [CodeQL queries](https://github.com/github/codeql)
