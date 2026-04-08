# Example AIDev configurations

Copy any of these into `<your-workspace>/.aidev/config.yaml` (or `~/.aidev/config.yaml` for user defaults) and edit to taste.

| File | When to use |
|------|-------------|
| [`config.ollama-basic.yaml`](config.ollama-basic.yaml) | First-time Ollama users — single model for both chat and autocomplete |
| [`config.ollama-dual-model.yaml`](config.ollama-dual-model.yaml) | Ollama with a small fast model for autocomplete and a larger one for chat |
| [`config.vllm-basic.yaml`](config.vllm-basic.yaml) | Single GPU vLLM server with one model |
| [`config.vllm-multi.yaml`](config.vllm-multi.yaml) | Two vLLM servers — one big chat model, one small autocomplete model |
| [`config.llamacpp.yaml`](config.llamacpp.yaml) | llama.cpp server (e.g., on Apple Silicon with Qwen2.5-Coder-7B-Instruct) |
| [`config.team-shared.yaml`](config.team-shared.yaml) | Workspace config committed to git, with project rules and ignored paths |
| [`config.cloud-fallback.yaml`](config.cloud-fallback.yaml) | Cloud (Claude) as primary, local Ollama as autocomplete model |

## Reminder: secrets

API keys are **never** stored in YAML. After picking a config, run **`AIDev: Set API Key`** from the command palette to save the key into VS Code's encrypted SecretStorage.
