# Champ Documentation

| Guide | Covers |
|---|---|
| [User Guide](USER_GUIDE.md) | Installation (CLI one-liner & VS Code `.vsix`), provider setup, VS Code modes/tools/@-context, headless CLI, skills, rules, agent teams, custom agents, MCP, shortcuts, and troubleshooting |
| [Configuration & Models](CONFIG.md) | Config precedence (`providers.json`, `.champ/provider.json`, `~/.champ/config.yaml`), full YAML schema (incl. SSH, triggers, routing, telemetry), migration, and model/hardware sizing |
| [Architecture](ARCHITECTURE.md) | Extension host/CLI architecture, agent loop, context engine, hallucination mitigation, `EndpointRegistry` & `SmartRouter`, SEA measurements, DAG/team runners, RAG index, safety, and observability |
| [Interfaces & System Prompts](REFERENCE.md) | Core TypeScript module contracts (`LLMProvider`, `Tool`, `EndpointRegistry`, `AgentController`, webview messages) and system prompt/mode/agent templates |
| [Operations, Security & Publishing](OPERATIONS.md) | Development workflow, `scripts/champ` unified CLI, Marketplace/Open VSX publishing checklist, SAST/SCA/secret scanning, and Grafana telemetry dashboard |
| [Enterprise Policy](POLICY.md) | Policy layer precedence, rule format, workspace trust, managed-file fail-closed behavior, and `champ policy show/validate` |
| [Grafana Dashboard](grafana/champ-analytics-dashboard.json) | Importable JSON dashboard for Champ observability metrics |
