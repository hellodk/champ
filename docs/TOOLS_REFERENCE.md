# Tool reference

This document covers agent-facing tool contracts that need operator context. The complete built-in tool list is in `docs/USER_GUIDE.md`.

## `git` — `git_create_pr`

The `git` tool exposes `git_status`, `git_diff`, `git_commit` and `git_create_pr`. `git_create_pr` requires approval in supervised mode. Its actual parameters are `title`, `description`, `base` (default `main`) and `head`; `githubToken` may be supplied explicitly, otherwise `GITHUB_TOKEN` from the environment is used. Git state is read via argument arrays (no shell interpolation). The handler refuses to run without a GitHub remote and a valid token.

### Example 1 — commit, then open a PR

```text
git action=git_commit files=["src/accounting.ts"] message="fix: correct token accounting"
git action=git_create_pr title="fix: correct token accounting" \
  description="Measured prefix tokens from provider usage." base=main \
  head=fix/token-accounting
```

The caller supplies the title and description; the tool does not derive them from the commit log. The returned output contains the PR number and URL.

### Example 2 — missing or invalid credential

Without `GITHUB_TOKEN` (or an explicit `githubToken`), the tool returns `Error: GITHUB_TOKEN not provided and GITHUB_TOKEN env var not set` and makes no API call. An invalid token returns `Error: GitHub token is invalid or does not have access` after `validateToken()`. Set the credential and retry the same action.

### Example 3 — no GitHub remote

If `GitUtils.getRemoteConfig` cannot determine the owner/repository, the tool returns `Error: Could not determine GitHub owner/repo from git remote`. Configure `origin` and retry.

## `web_search`

Uses the Brave Search API with `BRAVE_API_KEY`. Results are capped at 10 per call, registered in `WebSourceRegistry` as `[S#]` citations, and passed through `PromptGuard` before entering model context.

## `remote_run_terminal_cmd` / `remote_edit_file`

Extension-only SSH tools. They reuse the command sandbox and the extension's SSH connection pool. The CLI does not register them because it has no connection pool.

## `browser` — protocol-neutral browser automation

Champ speaks **W3C WebDriver** over HTTP by default. The tool never starts or downloads a browser binary, and Champ does not bundle Chromium. Operators supply the browser and driver/endpoint themselves, so no Brave, Chrome, Firefox, Safari or Edge installation is mandated.

`CHAMP_BROWSER_PROTOCOL` selects one of four adapters:

| Value | Adapter | Endpoint variable |
|---|---|---|
| `webdriver` (default) | W3C WebDriver HTTP | `CHAMP_WEBDRIVER_URL` (default `http://127.0.0.1:4444`) |
| `remote` | W3C WebDriver against a remote grid | `CHAMP_REMOTE_BROWSER_URL` |
| `cdp` | Chrome DevTools Protocol WebSocket or HTTP target list | `CHAMP_CDP_URL` |
| `playwright` | Optional Playwright package | `CHAMP_PLAYWRIGHT_BROWSER` (`chromium`, `firefox`, `webkit`) |

Additional settings:

- `CHAMP_BROWSER_CAPABILITIES_JSON` — W3C capabilities object sent as `alwaysMatch` (for example `{"browserName":"firefox"}`).
- `CHAMP_BROWSER_TIMEOUT_MS` — per-operation timeout, default `30000`.

The Playwright adapter is optional and never imported on the default path. Install it separately with `corepack pnpm add -D playwright`; Champ does not bundle it. `champ browser check` reports the configured adapter and endpoint status; `champ browser install` only prints setup instructions.

Examples:

```bash
# Default: local Selenium/W3C WebDriver server
export CHAMP_WEBDRIVER_URL=http://127.0.0.1:4444
export CHAMP_BROWSER_CAPABILITIES_JSON='{"browserName":"firefox"}'

# Remote Selenium Grid
export CHAMP_BROWSER_PROTOCOL=remote
export CHAMP_REMOTE_BROWSER_URL=http://selenium-grid.utilities.svc.cluster.local:4444

# CDP endpoint supplied by the operator
export CHAMP_BROWSER_PROTOCOL=cdp
export CHAMP_CDP_URL=ws://127.0.0.1:9222/devtools/page/1

# Optional Playwright adapter
export CHAMP_BROWSER_PROTOCOL=playwright
export CHAMP_PLAYWRIGHT_BROWSER=firefox
```

Navigation still passes through `validatePublicHttpUrl`; private/loopback URLs remain rejected as browser navigation targets even though driver endpoints are local infrastructure.
