# Agent Gateway — Champ's Local HTTP API

Champ ships a small authenticated HTTP server so external callers (CI bots,
scripts, other editors) can drive agent runs and read results. It starts
automatically with the extension.

## Connection info

- **URL**: `http://127.0.0.1:3148` (override with `CHAMP_SERVER_PORT` env var)
- **Auth**: Bearer token in `~/.champ/server-token.txt` (created `0600`)
- Timing-safe token comparison; every route except nothing is protected —
  `/health`, `/metrics` and the API routes all sit behind the same gate.

```bash
TOKEN=$(cat ~/.champ/server-token.txt)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3148/health
# {"status":"ok","version":"1.7.0","port":3148}
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | Liveness + version + port |
| GET  | `/metrics` | Prometheus text format (requests, steps, tool calls, failures) |
| POST | `/chat` | One-shot chat through the active provider |
| POST | `/run-team` | Launch a team run (returns `202` + `runId`) |
| GET  | `/runs` | List team runs |
| GET  | `/run/:id` | Status + result of one run |
| GET  | `/run/:runId/stream` | Server-Sent Events stream of run progress |

## Examples

**One-shot chat** (uses whatever provider `configSource` resolved):

```bash
curl -s -X POST http://127.0.0.1:3148/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "List the TypeScript config files in this repo"}'
```

**Launch a team run** (teams live in `.champ/teams/*.yaml`, see
[teams.md](teams.md)):

```bash
RUNID=$(curl -s -X POST http://127.0.0.1:3148/run-team \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"teamName":"devops-task-routing","task":"Migrate payments service to multi-region"}' \
  | jq -r .runId)

# Follow progress via SSE
curl -N -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3148/run/$RUNID/stream

# Poll instead
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3148/run/$RUNID | jq
```

**Scrape metrics** (Prometheus scrape config):

```yaml
scrape_configs:
  - job_name: champ
    authorization:
      credentials_file: /home/you/.champ/server-token.txt
    static_configs:
      - targets: ["127.0.0.1:3148"]
```

## CI bot pattern

A minimal GitLab/GitHub-CI step that asks the devops team to review a diff:

```bash
#!/usr/bin/env bash
set -euo pipefail
TOKEN=$(cat ~/.champ/server-token.txt)
BASE=http://127.0.0.1:3148

RUNID=$(curl -sf -X POST $BASE/run-team \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"teamName\":\"review\",\"task\":\"Review this diff: $(git diff HEAD~1 | jq -Rs .)\"}" \
  | jq -r .runId)

while true; do
  STATE=$(curl -sf -H "Authorization: Bearer $TOKEN" $BASE/run/$RUNID | jq -r .status)
  [ "$STATE" = "completed" ] && break
  [ "$STATE" = "failed" ] && exit 1
  sleep 5
done
curl -sf -H "Authorization: Bearer $TOKEN" $BASE/run/$RUNID | jq -r .result
```

## Security notes

- The server binds localhost only — do not expose it.
- The token file is your credential; treat it like a password.
- Team runs launched here inherit the team's execution mode (`safe` teams
  still prompt *in VS Code*; use `auto` teams for fully unattended runs).
