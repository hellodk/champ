# Context-fitting review — 2026-10-19 / 2026-10-20

Scope: the headless CLI's context fitting and the code the VS Code extension
shares with it — `src/providers/context-manager.ts`,
`src/providers/context-summariser.ts`, `src/agent/agent-controller.ts`,
`src/agent/tool-calling-loop.ts`, `src/session/session-log.ts`, the `read_file`
tools and the npm payload.

Method: three read-only external review passes (independent subagents, no repo
writes, probes run in `/tmp/opencode`), each finding fixed with a failing test
first, one commit per finding. All findings cite `file:line` or a probe that
reproduced them on the commit named.

## Verdict

The fitting code now holds its contract: nothing over budget is handed to a
provider, tool results are protected from the drop, and a prompt-based tool
result stays grouped with its call. Three passes were needed because each fix
opened a narrower version of the previous problem — that history is kept below
rather than squashed, since the failure modes are what future changes should be
tested against.

## Pass 1 — seven findings

| # | Finding | Fix |
|---|---|---|
| 1 | `fitMessages` / `fitWithSummary` fell back to `system + newest` even when that was far over budget (probe: 25 013 estimated tokens against a 1 000 budget). | `8856139`, `5d1eaeb` |
| 2 | The CLI `AgentController` path pushed tool output into history unbudgeted. | `6270e0e` |
| 2b | `atomicGroups` did not recognise prompt-based `<tool_result …>` user messages, so the drop boundary could split a call from its result. | `0e4447d` |
| 3 | A torn session header made `open` report "does not exist", so the CLI tried to create the id and failed on `EEXIST` forever with a contradictory message. | `0e46d08` |
| 4 | The summariser prompt budget was the fixed 8 000 chars, and an `error` delta silently degraded to `EMPTY_SUMMARY`, discarding dropped turns behind a placeholder. | `ad212cf` |
| 4b | Headless `read_file` read and split a whole file before applying its 2 000-line cap. | `b418660` |
| 4c | No `prepack` build, so the packaging guard passed a bin-less tarball. | `0cbba77` |

Regression guards for all of the above: `144f3d7`.

## Pass 2 — five findings

Independent verification of the seven fixes: 6 held, finding 1 held only for
single-block messages.

| # | Finding | Fix |
|---|---|---|
| 1 | The clamp shrank only the largest message per pass and applied a per-message budget to every block, so a message with several results stalled until the 12-pass cap, and a long run of results stayed over budget (probe: 9 768 and 8 448 estimated tokens against 2 000). | `6028950` |
| 2 | `<tool_result>` detection matched user prose that merely mentioned the tag, so the clamp rewrote the user's own words and grouping glued that turn to a tool call. | `2dad4e2` |
| 3 | The VS Code `read_file` still read whole files through `vscode.workspace.fs`. | `df0e3ef` (shared `src/utils/bounded-read.ts`) |
| 4 | A `startLine` past the 2 MB read prefix returned empty output as a success, so the model could conclude the range held nothing. | `60ca04c` |
| 5 | A corrupt session log exited 2 with no route back to a usable session. | `1c4b657` |

## Pass 3 — verification and one further finding

All five pass-2 fixes held. The pass-3 reviewer also reported, as High, that the
clamp's `MIN_TOOL_RESULT_CHARS` floor truncates a long opening tag
(`<tool_result tool="run_terminal_command" status="…`) and that the message then
stops being recognised as a tool result.

**That report did not reproduce** and is recorded here so it is not chased
again. The floor is only reached when `keep` is still solvable
(`over · CHARS_PER_TOKEN ≥ total − MIN`), which puts the smallest reachable
budget for a 4 KB result near 200 chars — at which the head is 90 characters and
a 59-character tag survives. Probed across windows 512/1 024/2 048/4 096/8 192,
bodies 600/1 200/4 000, through `fitMessages` and `fitWithSummary`, plus a
30-result pressure case: the wrapper was intact in every combination. The defect
only exists if `truncateToolOutput` is called at exactly 120 chars, which the
clamp never does for content of that size.

**The real defect in the same area** is that `fitMessages` dropped the whole
newest group when that group alone was over budget, then handed
`system + newest` to the clamp. With a bare question as the newest group the
clamp saw no clampable message, broke on `chars === 0`, and returned a set with
no tool results — discarding a huge result outright, silently, because the
survivor fitted:

```
system, user, assistant(toolCall), tool(300 KB result), "answer briefly"
budget 2048  →  [system, "answer briefly"], estimate 16
```

Fixed in `11858ec`: the last-resort clamp now receives the tail of the dropped
groups that still hold clampable tool results (whole groups, so a call stays
with its result), which is what it then shrinks. Guards: two tests in
`test/unit/providers/context-manager.test.ts`, both failing on the previous
source.

## Guards worth knowing about

- `test/unit/providers/context-manager.test.ts` — the `review 1`, `review 2`
  and `review 3` describes each fail if their specific clamp behaviour
  regresses.
- `test/e2e/cli.test.ts` — ships-binary guards: a budgeted tool result in the
  next request, and the corrupt-header exit path with its recovery hint.
- `test/unit/tools/read-file.test.ts`, `test/unit/utils/bounded-read.test.ts` —
  the 2 MB cap, the range error and the virtual-filesystem fallback.
- `test/unit/packaging/packaging-hygiene.test.ts` — the packed tarball really
  contains `dist/cli.js` (it runs `npm pack`, so `prepack` must build).

## Verification at `11858ec`

- `tsc --noEmit` clean; `eslint src test` 0 errors, 3 pre-existing warnings.
- unit 1 935 passed | 5 skipped; e2e 113 passed.
- integration 13 passed, only the pre-existing unrelated failures in
  `test/integration/tools/git-tool.integration.test.ts`
  (`gitUtils.parseGitHubUrl is not a function`, 7 tests).
