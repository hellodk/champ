# Releasing Champ

## Version source of truth

`package.json` has the only release version. Both delivered surfaces read it:

- the VS Code extension manifest is `package.json` itself;
- `src/cli.ts` reads the same file at runtime for `champ --version` and the REPL
  banner.

There is no second version file and no manual version edit.

## Automatic release flow

Every push to `master` runs `.github/workflows/release.yml`. The workflow:

1. reads the current version from `package.json`;
2. finds the newest reachable `v*` git tag;
3. computes the next patch version as
   `max(current version, newest tag) + 1`;
4. skips if that tag already exists remotely or HEAD is a `chore(release):`
   commit (safe re-runs);
5. runs `pnpm version <next> --no-git-tag-version`;
6. commits `package.json` as `chore(release): <next>` with Husky hooks disabled
   (tests run in CI, not during an automated commit);
7. tags `v<next>` and pushes the tag only — the protected `master` branch is
   updated separately, after its required checks pass;
8. builds the VSIX from the bumped commit;
9. verifies `node dist/cli.js --version` equals `champ <next>`;
10. publishes a GitHub release titled `Champ v<next>` with the VSIX as the
    first and only asset.

The workflow ignores pushes whose actor is `github-actions[bot]` and skips any
HEAD whose subject starts with `chore(release):`, so a release commit cannot
trigger another release. `concurrency` serialises releases if multiple commits
reach `master` close together.

## Local commands

```bash
scripts/champ version              # champ 2.0.2
scripts/champ version next         # 2.0.3
scripts/champ version next 2.0.2 v2.1.9  # 2.1.10
scripts/champ release              # push master; workflow does the rest
```

`scripts/champ release` no longer creates a GitHub release itself. Use it to
push `master`; the workflow is the single publisher.

## Installing a release

`scripts/champ install latest` continues to work because the generated VSIX is
the first asset on every GitHub release.

## Commit convention

Use conventional commits for all changes, including release commits produced by
the workflow (`chore(release): <version>`). No GitHub issues are required.
