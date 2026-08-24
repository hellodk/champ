# Champ — Documentation Index

Feature-by-feature guides with copy-paste examples. Config file samples live
alongside (see table below); deeper narrative docs are in [`docs/`](../docs/).

## Guides

| Doc | Covers |
|-----|--------|
| [`agents.md`](agents.md) | Chat modes, @-context symbols, built-in tools, approval flow, skills, safety nets |
| [`teams.md`](teams.md) | Team YAML schema, DAG scheduling, approval modes, SPAWN protocol, budgets, checkpoints & resume |
| [`agent-gateway.md`](agent-gateway.md) | Champ's local HTTP API: auth, /chat, /run-team, SSE streams, /metrics, CI-bot pattern |
| [`mcp.md`](mcp.md) | MCP servers (stdio + SSE), env secrets, tools/resources/prompts/sampling, marketplace |
| [`mcp-gateways.md`](mcp-gateways.md) | Connecting through corporate MCP gateways; exposing Champ as a gateway |
| [`advanced.md`](advanced.md) | Smart-routing rules, fallback/rate-limit/breaker chain, telemetry OTLP, audit log, memory banks, triggers, sandbox.yaml, index tuning, env substitution, delegation, SSH targets |

## Config file samples

| File | When to use |
|------|-------------|
| [`config.ollama-basic.yaml`](config.ollama-basic.yaml) | First-time Ollama users — single model for chat + autocomplete |
| [`config.ollama-dual-model.yaml`](config.ollama-dual-model.yaml) | Ollama with a small fast autocomplete model + larger chat model |
| [`config.vllm-basic.yaml`](config.vllm-basic.yaml) | Single GPU vLLM server |
| [`config.vllm-multi.yaml`](config.vllm-multi.yaml) | Two vLLM servers — big chat model, small autocomplete model |
| [`config.llamacpp.yaml`](config.llamacpp.yaml) | llama.cpp server (Apple Silicon / CPU) |
| [`config.team-shared.yaml`](config.team-shared.yaml) | Workspace config committed to git with project rules and ignore paths |
| [`config.cloud-fallback.yaml`](config.cloud-fallback.yaml) | Cloud Claude primary + local Ollama autocomplete |

## Secrets reminder

Cloud API keys **never** go in YAML — store them with
**`Champ: Set API Key`** (VS Code SecretStorage). Self-hosted server keys
may live in YAML (`apiKey:`) or `${{ secrets.KEY }}` references.
