# Publishing Champ to the VS Code Marketplace

A step-by-step runbook for packaging and publishing Champ to the Visual Studio Code Marketplace.

## Prerequisites

1. **Node.js 20+** and **npm 10+** (you already have these if you can build the extension).
2. **A Microsoft account** (personal or work).
3. **An Azure DevOps organization** — free; used to create the Personal Access Token.
4. **A Visual Studio Marketplace publisher** — free; the namespace your extensions are published under.
5. **`vsce`** — the VS Code Extension Manager CLI.

## One-time setup

### 1. Create an Azure DevOps organization

1. Open <https://dev.azure.com> and sign in with your Microsoft account.
2. Click **+ New organization** and pick any name (e.g., `your-name`).
3. The organization URL will be `https://dev.azure.com/your-name`.

### 2. Create a Personal Access Token (PAT)

1. In Azure DevOps, click your profile icon → **Personal access tokens**.
2. Click **+ New Token**:
   - **Name**: `vsce-publish`
   - **Organization**: `All accessible organizations` (critical — without this the token cannot be used for marketplace publish)
   - **Expiration**: up to 1 year
   - **Scopes**: click **Show all scopes**, then check **Marketplace → Manage**
3. Click **Create** and **copy the token immediately** — it's shown only once.

### 3. Create a Marketplace publisher

1. Open <https://marketplace.visualstudio.com/manage>.
2. Sign in with the same Microsoft account.
3. Click **Create publisher** and fill in:
   - **Name**: human-readable display name (e.g., `Champ OSS`)
   - **ID**: the stable identifier that must match `publisher` in `package.json`. For this project use `champ-oss`.
   - **Email**: your contact email
4. Click **Create**.

> ⚠️ The `publisher` field in `package.json` must match your publisher ID exactly. This project is set to `champ-oss`. Change both if you want to publish under a different name.

### 4. Install `vsce`

```bash
npm install -g @vscode/vsce
```

Or without installing globally:

```bash
npx @vscode/vsce --version
```

### 5. Log in with your PAT

```bash
vsce login champ-oss
```

Paste your PAT when prompted. `vsce` stores it in your system keychain for future runs.

## Package the extension

Builds a `.vsix` file you can install locally or upload manually.

```bash
# From the project root
npm run package          # production esbuild bundle
npx @vscode/vsce package # creates champ-0.1.0.vsix
```

The `.vsix` appears in the project root. Install it locally to test:

```bash
code --install-extension champ-0.1.0.vsix
```

## Publish

### Option A — publish from the CLI (automated)

```bash
# Make sure you're logged in (one-time; see setup step 5)
vsce login champ-oss

# Publish the currently-committed version
npx @vscode/vsce publish

# Or publish with an automatic version bump:
npx @vscode/vsce publish patch   # 0.1.0 -> 0.1.1
npx @vscode/vsce publish minor   # 0.1.0 -> 0.2.0
npx @vscode/vsce publish major   # 0.1.0 -> 1.0.0
```

### Option B — upload the `.vsix` manually

1. Go to <https://marketplace.visualstudio.com/manage/publishers/champ-oss>.
2. Click **+ New extension** → **Visual Studio Code**.
3. Upload the `.vsix` file created by `vsce package`.
4. Review the listing and click **Upload**.

The extension usually appears on the marketplace within 1-2 minutes.

## Pre-publish checklist

Before every release, verify:

- [ ] `npm run check-types` is clean (0 errors)
- [ ] `npm test` is green (all 306 tests pass)
- [ ] `npm run package` produces a bundle with no warnings
- [ ] `CHANGELOG.md` has an entry for the new version
- [ ] `package.json` version matches the CHANGELOG entry
- [ ] `README.md` is up to date
- [ ] `media/icon.png` is present and 128×128
- [ ] No secrets in the repo (`git grep -iE 'api[_-]?key|secret|password'`)
- [ ] `.vscodeignore` excludes `src/`, `test/`, `node_modules/`, `.vscode-test/`
- [ ] The extension activates cleanly in a fresh Extension Development Host
- [ ] The chat panel opens and a test message round-trips successfully

## Post-publish

- **Verify the listing**: open <https://marketplace.visualstudio.com/items?itemName=champ-oss.champ>.
- **Install from marketplace**: `code --install-extension champ-oss.champ` and smoke-test.
- **Tag the git commit**:
  ```bash
  git tag v0.1.0
  git push origin v0.1.0
  ```

## Continuous publishing (CI)

A future improvement is to publish from GitHub Actions on tag push. The workflow requires:

1. Store the PAT as a GitHub Actions secret named `VSCE_PAT`.
2. Add `.github/workflows/publish.yml`:

```yaml
name: Publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run check-types
      - run: npm test
      - run: npm run package
      - run: npx @vscode/vsce publish -p ${{ secrets.VSCE_PAT }}
```

## Troubleshooting

### `ERROR  Publisher champ-oss not found`
Your publisher ID doesn't exist, or your PAT doesn't have access. Re-run publisher setup (step 3) and regenerate the PAT with **All accessible organizations** (step 2).

### `ERROR  Missing publisher name`
The `publisher` field is absent from `package.json`. Already set to `champ-oss` in this repo; verify it wasn't removed.

### `ERROR  Icon media/icon.png does not exist`
Run the SVG-to-PNG conversion:
```bash
convert -background none -density 300 media/icon-marketplace.svg -resize 128x128 media/icon.png
```
(or use any other SVG to PNG tool).

### `ERROR  Make sure to edit the README.md`
`vsce` blocks publishing if the README still has placeholder text. Make sure `README.md` contains real content and doesn't start with "This is the README…".

### `ERROR  vscode engine compatibility version must be specified`
Already set in `package.json` as `"engines": { "vscode": "^1.93.0" }`. Don't remove this field.

### Package size too large
Check `.vscodeignore` — it should exclude `src/`, `test/`, `node_modules/`, `docs/`, `webview-ui/src/`. Only `dist/`, `webview-ui/dist/`, `media/`, `LICENSE`, `README.md`, and `package.json` need to ship.

```bash
npx @vscode/vsce ls            # lists files that will be included in the .vsix
```

## Version bump workflow

```bash
# 1. Make sure working tree is clean
git status

# 2. Update CHANGELOG.md with the new version's changes

# 3. Run full pre-publish checklist
npm run check-types && npm test && npm run package

# 4. Let vsce bump the version, commit, tag, and publish in one shot
npx @vscode/vsce publish patch   # 0.1.0 -> 0.1.1 (bugfix)
#   or
npx @vscode/vsce publish minor   # 0.1.0 -> 0.2.0 (feature)
#   or
npx @vscode/vsce publish major   # 0.1.0 -> 1.0.0 (breaking)

# 5. Push the commit and tag that vsce created
git push && git push --tags
```
