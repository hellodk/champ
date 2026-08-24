# MCP Gateways & Champ as a Gateway

Two directions of "gateway" — connecting Champ **through** an MCP gateway to
reach many backends, and calling Champ's agent **from outside** via its HTTP
API.

## 1. Connecting through an MCP gateway

An MCP gateway (e.g. an internal aggregator in front of Jira, Confluence,
internal APIs) exposes one SSE endpoint that fronts N upstream servers.
Champ connects with bearer auth:

```yaml
mcp:
  servers:
    - name: corp-gateway
      transport: sse
      url: https://mcp-gateway.internal.example.com/sse
      auth:
        type: bearer
        token: ${env:MCP_GATEWAY_TOKEN}
```

Patterns that work well:

| Pattern | Config hint |
|---------|-------------|
| **Aggregated tools** | Gateway fans out to internal services; tool names arrive namespaced — reference them plainly in prompts ("create the Jira ticket…") |
| **Per-team gateways** | One gateway URL per team; put them in *user* YAML so every project gets them without committing secrets |
| **Auth rotation** | Keep tokens in SecretStorage and reference via `${{ secrets.MCP_TOKEN }}`; rotate without touching YAML |
| **Air-gapped zones** | Gateway runs inside the protected zone; your workstation only needs outbound HTTPS to the single SSE URL |

Health-checking: connection failures never block other servers; use
`Champ: Reload MCP Server` after gateway-side changes instead of reloading
the window.

## 2. Champ as the gateway (HTTP API)

Champ's local server lets non-VS Code callers run agents and teams:

```
CI pipeline ──▶ POST /run-team ──▶ TeamRunner ──▶ tools + LLMs
Slack bot   ──▶ GET  /run/:id/stream (SSE)
Prometheus  ──▶ GET  /metrics
```

Full endpoint reference + curl/CI examples:
[agent-gateway.md](agent-gateway.md)

Security model recap:

- Binds `127.0.0.1` only; port via `CHAMP_SERVER_PORT`
- Bearer token from `~/.champ/server-token.txt`, timing-safe comparison
- Runs inherit team approval semantics — pick `auto` teams deliberately
- `/metrics` is authenticated like every other route; scrape with
  `authorization.credentials_file`

## 3. Chaining both

Gateway-in + gateway-out is a valid topology: an external bot calls
`POST /run-team`; the team's agents use MCP tools reached through your
corporate MCP gateway. Every hop stays authenticated (bot token → champ,
champ → gateway bearer), and every tool execution remains approval-gated or
sandboxed per your team configuration.
