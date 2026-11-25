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
