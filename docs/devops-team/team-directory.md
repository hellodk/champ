# DevOps Team — Champ Workflows

## Team

| Name | Role | Domain |
|------|------|--------|
| **Avinash** | Program Manager | Coordinates all workflows, stakeholder comms, deployment sign-offs |
| **Mohit** | Cloud Infra & Architecture Lead | Multi-cloud provisioning, cost, architecture reviews |
| **Preksha** | CI/CD & Release Engineering Lead | Pipelines, build systems, release automation, rollback |
| **Animesh** | Kubernetes & Container Lead | Cluster management, Helm, workload scheduling, container security |
| **Deepanshu** | Monitoring & Observability Lead | Alerts, dashboards, SLOs, incident triage from the signal side |
| **Prahlad** | Security, Compliance & Access Lead | IAM, CVE management, compliance, access reviews |
| **Tushar** | Networking & On-Prem Lead | Firewalls, DNS, BGP, VPN, on-prem hardware, load balancers |

---

## Workflows

### 1. Daily Standup
**File:** `.champ/teams/devops-standup.yaml`

Run this each morning. Each engineer provides their Yesterday / Today / Blockers.
Avinash synthesises a Slack-ready summary for leadership.

**How to run:**
Open Champ → Teams → `DevOps Daily Standup`

Or via command:
```
champ.runTeam devops-standup
```

**Input:** Any context Avinash wants the team to know (e.g. "We have a board review today, keep updates concise" or "No special context").

---

### 2. Task Routing
**File:** `.champ/teams/devops-task-routing.yaml`

Drop a new task or request in. Avinash triages it, routes to the right engineer(s),
each engineer produces an action plan, Avinash produces a final brief.

**How to run:**
Describe the task in plain English:
> "We need to migrate the payments service from us-east-1 to a multi-region setup. Currently single-AZ RDS, EKS cluster, and an ALB."

**Output:** Triage result → Engineer action plans → PM brief with timeline and dependencies.

---

### 3. Incident Response
**File:** `.champ/teams/devops-incident-response.yaml`

When something breaks. Paste the alert, Slack message, or symptom description.
Avinash declares the incident, Deepanshu leads monitoring triage, domain specialists
engage, Avinash produces a status update and resolution runbook.

**How to run:**
Describe the incident:
> "Payments API returning 503s. Error rate spiked to 40% at 14:32 IST. Affecting ~2000 users. No recent deployments."

**Output:** Severity classification → Monitoring triage → Domain-specific investigation → Status update + resolution runbook.

**Severity levels used:**
- **SEV1** — Total outage, all users affected
- **SEV2** — Partial outage or significant degradation
- **SEV3** — Minor impact, workaround available
- **SEV4** — No user impact, infra concern

---

### 4. Deployment & PR Review
**File:** `.champ/teams/devops-deployment-review.yaml`

Before any infra or service change goes to production. Paste the PR description,
Terraform plan, Helm values diff, or deployment spec. All reviewers run in parallel.
Avinash gives final GO / NO-GO.

**How to run:**
Describe the change:
> "Upgrading the EKS control plane from 1.27 to 1.29 across all three clusters.
> Using managed node groups. Planned for Saturday 02:00 IST. Staging tested last week."

**Output:** Review kickoff → Parallel domain reviews → Pipeline/rollback review → Final sign-off with checklist.

---

## Tips for Avinash

1. **Standup:** Run it before 10 AM. The output is ready to paste into Slack.
2. **Task routing:** The more context in the request, the better the action plans.
   Include ticket IDs, service names, and constraints.
3. **Incident:** Time matters. Paste the alert text as-is — don't spend time formatting it.
4. **Deployment review:** Include the full change description: what, why, and when.
   Reviewers need to know the *reason* for the change to assess blast radius.

## Adjusting Roles

If someone's domain changes, edit the relevant YAML file under `.champ/teams/devops-*.yaml`.
Each agent's `systemPrompt` defines their expertise. The `condition:` fields control
which engineers engage for task routing and incident response.
