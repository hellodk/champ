# Enterprise Policy

Champ evaluates policy before every tool execution and before approval
prompts. Rules are layered; the first matching rule in the highest-precedence
layer wins.

## Precedence

| Layer | Source | Can grant? |
|---|---|---|
| `managed` | File at `CHAMP_MANAGED_POLICY` | Yes — administrator-controlled |
| `user` | `~/.champ/policy.json` | Yes |
| `project` | `<workspace>/.champ/policy.json` | Only when the workspace is trusted |
| `session` | Runtime session rules | Yes |

Decisions are `ALLOW`, `ASK`, and `DENY`. `ASK` becomes `DENY` in headless runs.
If no rule matches, approval-requiring tools produce `ASK` and all other tools
are allowed. Managed and user policy files fail closed: malformed JSON or an
invalid rule prevents activation instead of being treated as an empty layer.

Project `ALLOW` rules are ignored unless the workspace is trusted. In the CLI,
trust requires `CHAMP_TRUST_WORKSPACE=1`; in VS Code it follows workspace trust.
Project `DENY` and `ASK` rules always apply.

## Rule format

```json
{
  "rules": [
    {
      "kind": "tool",
      "target": "run_terminal_cmd",
      "decision": "DENY",
      "reason": "disabled by admin"
    },
    {
      "kind": "shell",
      "target": "git push*",
      "decision": "DENY"
    },
    {
      "kind": "path",
      "target": "/etc/*",
      "decision": "DENY"
    }
  ]
}
```

`scope` is assigned from the layer that loaded the file. `kind` is one of
`tool`, `shell`, `path`, `mcp`, or `subagent`. `target` is an exact name or a
glob using `*` and `?`. Invalid entries are rejected; strict layers fail the
run.

## Diagnostics

```bash
CHAMP_MANAGED_POLICY=/etc/champ/policy.json champ policy show
CHAMP_MANAGED_POLICY=/etc/champ/policy.json champ policy validate
```

`show` prints the effective rules grouped by layer plus the rejected-rule
count. `validate` exits `0` when every rule is valid and `1` when any rule was
rejected. Neither command prints secret material.
