# Releasing Champ

## Version source of truth

`package.json` has the only release version. Both delivered surfaces read it:

- the VS Code extension manifest is `package.json` itself;
- `src/cli.ts` reads the same file at runtime for `champ --version` and the REPL
  banner.

There is no second version file and no manual version edit.

## Automatic release flow

Every push to `master` runs `.github/workflows/release.yml`. The workflow has two
stages so the version committed to `master` is the version that gets published.

### Stage 1 — plan the version (feature merge)

1. Read the current version from `package.json`.
2. Find the newest reachable `v*` git tag.
3. Compute the next version from conventional commits since that tag
   (`feat` → minor, breaking change → major, otherwise patch), based on
   `max(current version, newest tag)`.
4. Skip if that tag already exists remotely.
5. Run `pnpm version <next> --no-git-tag-version`.
6. Commit `package.json` as `chore(release): <next>` with Husky hooks disabled
   (tests run in CI, not during an automated commit).
7. Push `release/v<next>`, open a pull request to `master`, and enable
   auto-merge with `--auto --squash`.

Branch protection requires lint, type check, unit/integration/e2e tests and the
supply-chain check, so the version PR cannot merge until CI is green. A push
whose HEAD subject starts with `chore(release):` skips this stage, which prevents
a version commit from planning another release. `concurrency` serialises
releases if several commits reach `master` close together.

### Stage 2 — publish (version commit merged to master)

1. Read the version from the merged `package.json` on `master`.
2. Run `pnpm run compile` (extension and CLI from the same commit), package the
   VSIX, and run `npm pack --ignore-scripts` for the CLI tarball.
3. Rename the tarball to `champ-cli-<version>.tgz`.
4. Verify `node dist/cli.js --version` equals `champ <version>` and that
   `package.json` matches.
5. Tag the master commit `v<version>`, push the tag, and create a GitHub release
   titled `Champ v<version>` with both assets: `champ-<version>.vsix` and
   `champ-cli-<version>.tgz`.

Nothing is published from a release branch. Both artifacts come from the master
commit that contains the version bump.

### Publish triggers

Auto-merge enabled with `GITHUB_TOKEN` does not emit a master push event, so the
publish stage runs on the `closed` `pull_request` event of the version PR (after
required checks pass). A master push of a `chore(release):` commit and a manual
`workflow_dispatch` are additional triggers. An existing tag makes any later
trigger skip the publish, so a release is never duplicated.

To recover a missed publish, run the workflow manually from the Actions tab or:

```bash
gh workflow run release.yml --ref master
```

## Local commands

```bash
scripts/champ version              # champ 2.0.2
scripts/champ version next         # 2.0.3 (no feat/breaking commits)
CHAMP_VERSION_COMMITS="feat: add browser install" scripts/champ version next 2.0.2 v2.0.2  # 2.1.0
scripts/champ version next 2.0.2 v2.1.9  # 2.1.10
scripts/champ release              # push master; workflow does the rest
```

`scripts/champ release` no longer creates a GitHub release itself. Use it to
push `master`; the workflow is the single publisher.

## Installing a release

`scripts/champ install latest` downloads the VSIX asset from the latest GitHub
release. `champ update` downloads the `champ-cli-<version>.tgz` asset from that
same release by default. `champ update --ref <branch-or-tag>` is the edge
channel: it still clones, builds, and installs locally. If no published CLI
asset is available, `champ update` falls back to that build path.

## Commit convention

Use conventional commits for all changes, including release commits produced by
the workflow (`chore(release): <version>`). No GitHub issues are required.
