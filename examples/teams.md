# Creating Agent Teams

Teams are YAML-defined groups of specialised agents that Champ runs as a
dependency-ordered DAG with parallel batches, shared memory, token budgets
and checkpoints. Store them in `.champ/teams/*.yaml` (workspace) or
`~/.champ/teams/*.yaml` (user).

## Minimal team

```yaml
# .champ/teams/review.yaml
name: review
description: Two-person review crew

execution:
  mode: supervised        # safe | supervised | auto
  maxParallel: 2          # agents per parallel group
  timeoutSeconds: 300     # per-agent timeout
  tokenBudget: 200000     # soft stop when cumulative tokens exceed this

agents:
  - id: reviewer
    role: >
      Senior code reviewer. Inspect the diff for correctness, edge cases
      and style. Be terse.
    tools: [read_file, grep_search, list_directory]

  - id: summariser
    role: Summarise the review findings into three bullet points.
    dependsOn: [reviewer]
```

Run it: `Champ: Run Agent Team` → pick `review`, or
`Champ: Browse Team Marketplace`, or via the API gateway
([agent-gateway.md](agent-gateway.md)).

## Agent fields (all verified against `team-definition.ts`)

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string, required | Unique in the team; used by `dependsOn` |
| `role` | string | System-prompt persona for the agent |
| `model` | string | Override model for this agent (must be discoverable) |
| `tools` | string[] | Allow-list of tool names; scoped registry per agent |
| `dependsOn` | string[] | Must finish first; outputs available via shared memory |
| `condition` | string | Skip agent when false, e.g. `"tests.status == \"passed\""` |
| `outputFormat` | string | Post-execution validation hint |
| `selfCritique` | boolean | One critique pass after execution |
| `selfCritiqueMinContextWindow` | number | Skip critique on small-context models |

## Execution semantics

- **DAG scheduling**: Kahn topological sort; independent agents run in the
  same parallel batch (`maxParallel` at a time). Cycles are rejected at load.
- **Approval gates** (`execution.mode`):
  - `safe` — one approval per parallel group before it starts
  - `supervised` — per-agent approval before each runs
  - `auto` — fully unattended (explicitly autonomous; no prompts)
- **Token budget**: warning event at 80%, pending agents skipped at 100%.
- **Timeouts**: per-agent `timeoutSeconds`; timeout cascades an abort into
  that agent's tool loop.
- **BLOCKED protocol**: an agent output starting with `BLOCKED: <reason>`
  lets downstream agents skip or retry with injected context.
- **Dynamic spawning**: an agent may emit a line
  `SPAWN {"id":"helper","role":"...","dependsOn":["reviewer"]}` — spawned
  agents join after the current group completes (cap: 10, duplicates/cycles
  dropped).

## Checkpoints & resume

Every completed agent writes
`.champ/team-runs/<runId>/checkpoint-<agentId>.json`. Resume any run:

```
Champ: List Team Runs      → pick run
Champ: Resume Team Run     → continues pending agents with restored memory
```

## Shared memory between agents

Outputs land in shared memory keyed by agent `id`; reference upstream data
in prompts implicitly ("summarise the review findings") — the runner injects
`dependsOn` outputs. Typed keys: `__userRequest`, `__workspaceRoot`.
Pub/sub channels exist for advanced flows (`publish_channel` tool +
`subscribe` in agent code paths).

## Real-world examples

See [`docs/devops-team/team-directory.md`](../docs/devops-team/team-directory.md)
for a seven-agent DevOps team (standup synthesiser + task router across CI/CD,
K8s, security, networking specialists) with ready-made YAML under
`.champ/teams/devops-*.yaml`.

## UI helpers

- **Team Builder** (`Champ: Open Team Builder`) — visual canvas, drag nodes,
  edit deps, save YAML
- **Templates** — `Champ: Create Team from Template`
- **AgentGraphPanel** — live dependency graph while a team executes
