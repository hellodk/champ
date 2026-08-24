# MCP (Model Context Protocol) in Champ

Champ is a full MCP client: connect external tool servers, use their tools
inside agent runs, read their resources via `@MCP`, invoke their prompts,
and even let servers sample your LLM through Champ's sampling bridge.

## Configuring servers

Either VS Code settings (`champ.mcp.servers`) or YAML — both share the same
schema. YAML example:

```yaml
mcp:
  servers:
    # 1. Local process over stdio
    - name: filesystem
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/projects"]
      env:
        NODE_ENV: production

    # 2. Remote server over SSE with bearer auth (gateway pattern)
    - name: team-gateway
      transport: sse
      url: https://mcp.internal.example.com/sse
      auth:
        type: bearer
        token: ${env:MCP_GATEWAY_TOKEN}

    # 3. Stdio server whose env pulls from SecretStorage
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"
```

Notes:

- `transport` defaults to `stdio`; SSE servers take `url` instead of `command`
- `auth.type: "bearer"` injects `Authorization: Bearer <token>` on the SSE
  connection; custom headers are supported by the connection layer
- `${{ secrets.KEY }}` values are resolved from **VS Code SecretStorage**
  (`Champ: Set API Key` stores under any key name); unset variables are left
  as literal text rather than silently emptied

## What you get

| Capability | How to use |
|---|---|
| **Tools** | Appear in the agent's tool list as `mcp__<server>__<tool>`; approval-required by default |
| **Resources** | `@MCP(server:uri)` in chat injects the resource contents |
| **Prompts** | `@MCPPrompt(server:name?key=value)` expands a server-side prompt template |
| **Sampling** | Servers can request LLM completions through Champ's active provider (sampling bridge) |

The status broadcast shows per-server tool/resource/prompt counts;
`Champ: Reload MCP Server` reconnects one server without a window reload.

## Discovery & marketplace

`Champ: Browse MCP Servers` opens the marketplace panel listing community
servers with one-click install into your config (env fields resolved through
SecretStorage, never plaintext).

## Troubleshooting

- Connection failures for one server never block others; failures are logged
  and surfaced in the MCP status broadcast.
- Passive SSE retry: dropped connections reconnect with capped backoff
  (max 10 attempts, 30s ceiling) unless you aborted intentionally.

See [mcp-gateways.md](mcp-gateways.md) for gateway topology patterns.
