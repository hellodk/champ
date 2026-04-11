# Publishing Champ to the Marketplace

Complete walkthrough from zero to published, for both the **VS Code Marketplace** (official) and **Open VSX** (VSCodium / Cursor / other forks).

---

## Prerequisites checklist

- [ ] Node.js 20+ installed
- [ ] Git repository with clean working tree
- [ ] `package.json` reflects the version you want to ship
- [ ] All tests pass: `npm test`
- [ ] TypeScript clean: `npm run check-types`
- [ ] ESLint clean: `npm run lint`
- [ ] `README.md` is marketplace-ready (this is what users see)
- [ ] `CHANGELOG.md` has entries for the current version
- [ ] `LICENSE` file is present
- [ ] Icon at `media/icon.png` is 128×128 or 256×256 PNG
- [ ] No secrets in source (API keys, tokens, passwords)

Run the full pre-flight check:

```bash
npm run check-types && npm run lint && npm test && npm run package
```

---

## Part 1 — Publish to VS Code Marketplace

### Step 1: Create a Microsoft / Azure DevOps account

Both services use the same login.

1. Go to https://dev.azure.com
2. Sign in with any Microsoft account (or create one)
3. Create a default organization if prompted (any name works — it's just a container for your PAT)

### Step 2: Create a Marketplace publisher

1. Go to https://marketplace.visualstudio.com/manage/publishers
2. Click **Create publisher**
3. Fill in:
   - **Publisher ID**: must be globally unique; this becomes part of the extension's identifier (`<publisher>.champ`)
   - **Publisher Name**: human-readable (e.g. "Champ OSS")
   - **Email**: contact address
4. Click **Create**

> **Important**: The publisher ID you choose here **must match** the `"publisher"` field in `package.json`. Current value: `champ-oss`. If you can't claim that ID, change `package.json` to your actual publisher ID.

### Step 3: Generate a Personal Access Token

1. Go to https://dev.azure.com → click your profile icon (top right) → **Personal access tokens**
2. Click **New Token**
3. Configure:
   - **Name**: `champ-publish`
   - **Organization**: **All accessible organizations** (critical — don't limit to one org)
   - **Expiration**: Custom defined → up to 1 year
   - **Scopes**: click **Show all scopes** → scroll to **Marketplace** → check **Manage**
4. Click **Create**
5. **Copy the token immediately** — it will never be shown again

### Step 4: Login vsce

```bash
npx @vscode/vsce login <your-publisher-id>
# Paste the PAT when prompted
```

### Step 5: Bump version and update changelog

```bash
npm version patch  # 1.3.2 → 1.3.3 (bug fixes)
npm version minor  # 1.3.2 → 1.4.0 (new features, backward-compatible)
npm version major  # 1.3.2 → 2.0.0 (breaking changes)
```

Then edit `CHANGELOG.md` — add a top section for the new version describing what changed.

### Step 6: Package and inspect locally

```bash
npm run package
npx @vscode/vsce package --no-dependencies
```

This creates `champ-<version>.vsix`. Inspect what's inside:

```bash
unzip -l champ-1.3.2.vsix | head -50
```

Verify:
- ✓ `extension/dist/extension.js` present
- ✓ `extension/webview-ui/dist/main.js` + `main.css` present
- ✓ `extension/webview-ui/dist/codicons/codicon.ttf` present (icons)
- ✓ `extension/media/icon.png` present
- ✓ `extension/README.md` present
- ✓ `extension/CHANGELOG.md` present
- ✗ NO `node_modules` (excluded by `.vscodeignore`)
- ✗ NO `.git`, `.vscode`, test files, source `.ts` files
- ✗ NO `.env`, secrets, or credentials

### Step 7: Test the packaged VSIX locally

```bash
code --install-extension ./champ-1.3.2.vsix --force
```

Reload VS Code and smoke-test:
- Open the Champ sidebar
- Create a new session
- Send a message
- Verify icons render
- Verify tab bar, model picker, mode picker work

### Step 8: Publish to the Marketplace

```bash
npx @vscode/vsce publish --no-dependencies
```

Or bump + publish in one command:

```bash
npx @vscode/vsce publish patch --no-dependencies
npx @vscode/vsce publish minor --no-dependencies
npx @vscode/vsce publish major --no-dependencies
```

### Step 9: Verify on the marketplace

Wait 5-30 seconds for indexing, then visit:

```
https://marketplace.visualstudio.com/items?itemName=<publisher>.champ
```

First-time submissions go through an automated review (typically minutes to a few hours). You'll get an email if it fails validation.

### Step 10: Install from marketplace

```bash
code --install-extension champ-oss.champ
```

Or search "Champ" in the VS Code Extensions view.

---

## Part 2 — Publish to Open VSX Registry

Open VSX is a vendor-neutral marketplace used by **VSCodium, Cursor, Gitpod, Theia**, and other VS Code forks.

### Step 1: Create an Eclipse Foundation account

1. Go to https://open-vsx.org
2. Click **Sign in** → **Log in with GitHub** (or create an Eclipse account)
3. Sign the Publisher Agreement (first-time only)

### Step 2: Generate an Open VSX access token

1. Click your profile → **Settings** → **Access Tokens**
2. Click **Generate New Token**
3. Give it a name (e.g. `champ-publish`) and copy the token

### Step 3: Create a namespace (first time only)

```bash
npm install -g ovsx
npx ovsx create-namespace <your-publisher-id> -p <OPEN_VSX_TOKEN>
```

### Step 4: Publish

```bash
npx ovsx publish champ-1.3.2.vsix -p <OPEN_VSX_TOKEN>
```

### Step 5: Verify

```
https://open-vsx.org/extension/<publisher>/champ
```

---

## Telemetry & Analytics

### What Microsoft's Marketplace gives you (for free)

When you publish to the VS Code Marketplace, the **Publisher Hub** at https://marketplace.visualstudio.com/manage/publishers/<your-publisher> shows:

| Metric | Granularity |
|---|---|
| **Installs (total)** | Cumulative count of unique installs |
| **Installs by day** | Daily install count (last 90 days) |
| **Downloads** | Total downloads including updates |
| **Ratings** | Number of ratings, average star score |
| **Reviews** | User-submitted reviews |
| **Q&A** | User questions and your responses |
| **Trending** | Position in trending rankings (if applicable) |
| **Acquisition source** | Install source (marketplace browse / search / direct URL) |

**What you do NOT get:**
- Individual user identities
- Geographic/demographic data (country, age, gender, etc.)
- Usage analytics (which commands they run, how long they use it)
- Crash reports from users
- Per-user events

Microsoft considers this user privacy data and does not share it with publishers.

### Open VSX analytics

Open VSX provides far less — essentially just total download count. No geographic or demographic data.

### If you want real telemetry

You need to build it yourself. Two common approaches:

**Option 1: VS Code's built-in telemetry reporter**

```bash
npm install @vscode/extension-telemetry
```

```typescript
import TelemetryReporter from "@vscode/extension-telemetry";

const reporter = new TelemetryReporter("<your-app-insights-key>");

// Send events
reporter.sendTelemetryEvent("session.created", {
  provider: "ollama",
  model: "qwen2.5-coder",
});

// Send errors
reporter.sendTelemetryErrorEvent("provider.load.failed", {
  error: err.message,
});
```

Requires an **Azure Application Insights** instance (https://portal.azure.com — free tier available). You get per-event data with geographic info (country-level only, from IP). Users can disable via VS Code's `telemetry.telemetryLevel` setting — Champ **must respect** this.

**Option 2: PostHog / Mixpanel / your own endpoint**

```typescript
// Only if user has opted in AND VS Code telemetry is on
if (vscode.env.isTelemetryEnabled) {
  await fetch("https://your-analytics.com/event", {
    method: "POST",
    body: JSON.stringify({
      event: "session_created",
      anonymousId: vscode.env.machineId,  // opaque hash, no PII
      properties: { provider: "ollama" },
    }),
  });
}
```

### Telemetry best practices (and legal requirements)

1. **Respect `vscode.env.isTelemetryEnabled`** — if this returns `false`, send NOTHING
2. **Never send PII** — no file contents, file paths (beyond extension), user names, etc.
3. **Use `vscode.env.machineId`** — this is an opaque hash VS Code provides; not a user ID
4. **Document it in README** — users must be able to understand what you collect
5. **Add a setting to disable it** — `champ.telemetry.enabled: false` as a fallback
6. **Privacy policy URL** — add a `privacyUrl` to your extension's marketplace listing

### Realistic expectations for a new open-source extension

| Metric | Expectation (first 30 days) |
|---|---|
| Installs | 50-500 |
| Active users | ~30-50% of installs |
| Reviews | 0-3 |
| Q&A threads | 0-2 |
| Marketplace position | Page 5+ for "ai" keyword |

Promoting via Reddit, Hacker News, Twitter, or a blog post can multiply these numbers significantly.

---

## Continuous Publishing with GitHub Actions

Automate publishing on every tag push. Create `.github/workflows/publish.yml`:

```yaml
name: Publish Extension

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run check-types
      - run: npm run lint
      - run: npm test
      - run: npm run package
      - run: npx @vscode/vsce publish --no-dependencies -p ${{ secrets.VSCE_PAT }}
      - run: npx ovsx publish -p ${{ secrets.OVSX_PAT }}
```

Add two secrets in repo settings → Secrets and variables → Actions:
- `VSCE_PAT` — your Azure DevOps PAT
- `OVSX_PAT` — your Open VSX token

Then cut a release:

```bash
git tag v1.3.2
git push origin v1.3.2
```

---

## Versioning policy

| Version bump | When |
|---|---|
| **Patch** (1.3.2 → 1.3.3) | Bug fixes only, no behavior change |
| **Minor** (1.3.2 → 1.4.0) | New features, backward-compatible |
| **Major** (1.3.2 → 2.0.0) | Breaking changes |

Pre-releases:

```bash
npx @vscode/vsce publish --pre-release --no-dependencies
```

---

## Common problems

### "Publisher X not found"

The `"publisher"` field in `package.json` doesn't match your actual publisher ID. Fix:

```json
{ "publisher": "your-actual-publisher-id" }
```

### "Failed request: (401) TF400813"

Your PAT is expired or has wrong scopes. Generate a new one with **Marketplace → Manage** scope and **All accessible organizations**.

### "Icon file not found"

`media/icon.png` must be a PNG (not SVG) of at least 128×128. Verify:

```bash
file media/icon.png
```

### "Extension not found after publish"

Marketplace indexing takes up to 5 minutes. Hard-refresh. If still missing, check your email for validation failures.

### "README images broken on the marketplace"

Image paths must be absolute URLs (not relative). Replace:

```markdown
![screenshot](./docs/images/screenshot.png)
```

with:

```markdown
![screenshot](https://raw.githubusercontent.com/<you>/champ/main/docs/images/screenshot.png)
```

---

## Pre-publish final checklist

- [ ] `package.json` version bumped
- [ ] `CHANGELOG.md` has an entry for the new version
- [ ] `README.md` reflects current features
- [ ] `npm run check-types` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run package` succeeds
- [ ] `.vsix` inspected — no secrets, no `node_modules`, codicons present
- [ ] Packaged `.vsix` installed locally and smoke-tested
- [ ] Git working tree clean and committed
- [ ] Publisher ID in `package.json` matches your marketplace publisher
