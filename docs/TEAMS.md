# Agent Teams

Agent Teams let you define a named group of specialised AI agents that collaborate on complex tasks.
Teams are domain-agnostic — DevOps, fullstack, SRE, code review, data science, PM, mobile, content,
or any combination of roles that matches your workflow.

## Quick start

1. Open VS Code with a workspace
2. Run **Champ: Create Team from Template** (`Ctrl+Shift+P`)
3. Pick a template (DevOps Platform, Fullstack Feature, Code Review, Incident Response)
4. The template is written to `.champ/teams/<name>.yaml` and opened for editing
5. Customise system prompts and the agent list for your project
6. Run **Champ: Run Agent Team** and pick your team

## Team definition format

Teams are defined as YAML files in `.champ/teams/`. Any `.yaml` file in that directory is loaded automatically.

```yaml
name: My Team
description: What this team does
version: "1"

defaults:
  model: ""          # leave blank = use active provider model
  maxTokens: 6000
  temperature: 0.1   # low = deterministic output

execution:
  maxParallel: 3     # max agents running simultaneously
  totalTokenBudget: 100000  # hard cap across all agents
  timeoutSeconds: 120        # per-agent timeout
  retries: 1                 # retry failed agents N times
  checkpoints: true          # save state after each agent
  mode: auto                 # auto | safe | supervised

agents:
  - id: unique-id            # referenced in dependsOn
    name: Display Name       # shown in the team panel
    role: One-line role      # injected into system prompt header
    systemPrompt: |
      Full system prompt.
      Use {{key.path}} to reference outputs from earlier agents.
    dependsOn: [other-id]   # agent IDs this must wait for (default: [])
    condition: "plan.infra != null"  # skip this agent if expression is false
    tools: [read_file, create_file]  # allowed tools (default: none)
    model: ""                # override model for this agent
    maxTokens: 4096
    outputKey: my_key        # shared memory key (default: agent id)
    outputFormat: text       # text | json | files
    selfCritique: false      # enable adversarial self-review pass
```

## Execution model

Agents run in dependency order. Independent agents run in parallel up to `maxParallel`:

```
PM (no deps)
  ├── Infra  (depends on pm) ──┐
  └── CI/CD  (depends on pm) ──┤── Security (depends on infra + cicd)
                               └── Monitoring (depends on infra)
                                                     │
                                               Tech Lead (depends on all)
```

## Template variables

Reference earlier agents' outputs in system prompts:

```
{{plan}}                         → full output of agent with outputKey "plan"
{{plan.assignments.infra}}       → JSON field from agent with outputKey "plan"
{{infra}}                        → output of agent with outputKey "infra"
```

If a variable resolves to null, `(not available)` is substituted and a warning is shown in the panel.

## Condition expressions

Skip agents that have no relevant work:

```yaml
condition: "plan.assignments.infra != null"   # run only if PM assigned infra work
condition: "infra.success == true"            # run only if infra succeeded
condition: ""                                 # always run (default)
```

Supported: `== null`, `!= null`, `== true`, `== false`, `!= true`, `!= false`.

## Anti-hallucination features

### BLOCKED state

When an agent cannot complete its task safely, it should respond with:
```
BLOCKED: <one sentence explaining what is missing>
```

The team panel shows the blocked agent with **Skip** and **Retry** buttons.
Always include this instruction in your system prompts — it prevents guessing.

### Structured output tags

Separate reasoning from actual output:
```
<reasoning>
Think through the problem here — this is discarded.
</reasoning>

<output>
The actual code or content — this is what gets stored and passed forward.
</output>
```

### JSON output validation

Set `outputFormat: json` for agents producing structured data (like a PM planning agent).
The runner validates the output is parseable JSON and warns if not.

### Self-critique

Set `selfCritique: true` for critical agents. An adversarial follow-up asks "find at least one problem".
If a serious issue is found, one automatic retry is triggered. Doubles token cost — use selectively.

## Available tools

| Tool | What it does |
|------|-------------|
| `read_file` | Read file contents |
| `edit_file` | Edit an existing file |
| `create_file` | Create a new file |
| `delete_file` | Delete a file |
| `list_directory` | List directory contents |
| `grep_search` | Search with regex |
| `file_search` | Search by filename pattern |
| `run_terminal_cmd` | Execute a shell command |
| `codebase_search` | Semantic search |
| `generate_doc` | Write a structured document |
| `generate_diagram` | Create a Mermaid diagram |

**Tip**: Give planning agents no tools. Give implementation agents only what they need.

## Commands

| Command | Description |
|---------|-------------|
| `Champ: Run Agent Team` | Pick a team and run it |
| `Champ: List Agent Teams` | View all loaded teams |
| `Champ: Create Team from Template` | Scaffold from a built-in template |

## Built-in templates

| Template | Agents | Use for |
|----------|--------|---------|
| DevOps Platform | PM → Infra / CI/CD → Security → Monitoring → Tech Lead | Infrastructure, platform changes |
| Fullstack Feature | PM → Backend / Frontend → Tests / Docs | Shipping features |
| Code Review | Security / Performance / Style → Summary | Reviewing PRs or files |
| Incident Response | Investigator → Mitigator → Postmortem | Production incidents |

## Custom teams (examples)

**Data Engineering**: Pipeline Engineer / SQL Analyst → Data Quality → Docs

**Mobile**: PM → iOS / Android → QA → Release Notes

**Security Assessment**: Threat Modeler → Pen Tester → Compliance → Report

**Content**: Researcher → Writer → Editor → SEO
