# AIDev — Local Model Selection Guide

A practical guide to picking the right open model for AIDev's chat-driven file editing on local hardware. Last updated: 2026-04-06.

## What you actually need from a model

Chat-driven file editing has three hard requirements:

1. **Instruction following** — when you say "create a hello world Python file", the model must understand you want it to *do something* and not *describe* something. **Base models fail this test.** You need an *instruct* (instruction-tuned) variant.

2. **Tool calling** — the model must reliably emit either native `tool_use` calls (for providers that support it) or our `<tool_call>` XML format (the prompt-based fallback). Most modern instruct models can do this; a 7B+ instruct model typically works well.

3. **Code reasoning** — strong enough at code to write meaningful edits, not just plausible-looking syntax.

## Why your current setup failed

If you saw the model "happily explain how to create a file" instead of actually creating it, the cause is one of:

- **Wrong variant**: you have the *base* GGUF (e.g. `Qwen2.5-Coder-3B-Q4_K_M.gguf`). Base models are completion-only — trained to extend a prefix, not to follow instructions. You need the **`-Instruct`** variant.
- **Model too small**: 1-3B instruct models can follow simple instructions but rarely emit reliable structured tool calls. Move to 7B+.
- **Old extension**: prior to v0.1.2, AIDev didn't wire prompt-based tool calling, so even an instruct model wouldn't get the tool catalog. Upgrade to v0.1.2+.

## Recommendations by hardware tier

### Tier 1 — best price/quality for local agent work right now

These are my top picks for AIDev specifically.

| Model | Size on disk (Q4_K_M) | RAM budget | Why |
|-------|----------------------|-----------|-----|
| **Qwen2.5-Coder-7B-Instruct** | ~4.5 GB | 8 GB+ | Same family as the popular base model but instruct-tuned. Excellent at "create file X" instructions. Native tool-calling support in llama.cpp ≥ b4080. **My recommended starting point.** |
| **Qwen2.5-Coder-14B-Instruct** | ~8 GB | 16 GB | Significantly better reasoning than the 7B. Still fits in 16 GB unified memory with headroom for context. **My recommendation if you have the RAM.** |
| **Llama-3.1-8B-Instruct** | ~5 GB | 8 GB+ | Solid generalist with native tool calling. Slightly weaker at code than Qwen Coder but better at conversational reasoning. Good fallback. |
| **DeepSeek-Coder-V2-Lite-Instruct** | ~10 GB | 12 GB | MoE design (16B total / 2.4B active) → fast inference, strong code, ~3 GB active memory. Worth trying if 8B is too slow. |

### Tier 2 — when you want maximum capability

| Model | Size on disk (Q4_K_M) | RAM budget | Notes |
|-------|----------------------|-----------|-------|
| **Qwen2.5-Coder-32B-Instruct** | ~18 GB | 24 GB | Approaches Claude Sonnet quality on code tasks. **Tight fit on 16 GB** — try Q3_K_M (~14 GB) if you can't run Q4. |
| **DeepSeek-V3 Lite** | varies | varies | Best open model for agent work as of early 2026. Big weights, requires server-class hardware. |
| **Llama 3.3 70B Instruct** | ~40 GB (Q4_K_M) | 48 GB+ | Best quality of any open model. Won't fit on 16 GB without aggressive quantization. |

### Tier 0 — for autocomplete only (do not use for chat)

These are fine for inline ghost-text completion (`aidev.autocomplete.model`), but **not** for chat. They lack instruction following.

| Model | Size | Use for |
|-------|------|---------|
| Qwen2.5-Coder-1.5B (base or instruct) | ~1 GB | Inline autocomplete only |
| Qwen2.5-Coder-3B-Base | ~2 GB | Inline autocomplete only |
| StarCoder2-3B | ~2 GB | Inline autocomplete only |
| DeepSeek-Coder-1.3B | ~1 GB | Inline autocomplete only |

## Quick start: install + configure Qwen2.5-Coder-7B-Instruct

```bash
# Pull the GGUF (requires huggingface-cli; pip install huggingface-hub)
huggingface-cli download Qwen/Qwen2.5-Coder-7B-Instruct-GGUF \
  qwen2.5-coder-7b-instruct-q4_k_m.gguf \
  --local-dir ~/models

# Start llama.cpp server with it (replace --host with your IP if remote)
./llama-server -m ~/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf \
  --host 0.0.0.0 --port 21434 \
  --n-gpu-layers 99 \
  --ctx-size 16384
```

Then in VS Code settings (`Ctrl+Shift+P` → `Preferences: Open Settings (UI)`, search `aidev`):

- **`aidev.provider`** → `llamacpp`
- **`aidev.llamacpp.baseUrl`** → `http://192.168.1.24:21434/v1` (or wherever your server is)
- **`aidev.llamacpp.model`** → the exact `id` value from `curl <baseUrl>/models`

Reload the window. Send `create a hello world python file` and the file should actually appear in your workspace.

## Verifying tool calling actually works

After install, the canonical smoke test is:

```
create a hello world python file
```

What you should see in the chat:

1. A brief planning message ("I'll create a hello world Python file.")
2. A tool call card titled `create_file` with `path=hello_world.py` and the `print("Hello, World!")` content
3. An approval prompt (in v0.1.3+)
4. After approval, the file appears in your workspace and a confirmation appears in the chat

If you see only step 1 (a markdown explanation with no tool call), the model isn't following the prompt-based tool format. Try a different model from Tier 1.

## Other test prompts

Once basic tool calling works, try these in order of difficulty:

| Prompt | What it tests |
|--------|---------------|
| `read package.json and tell me the version` | `read_file` |
| `find all files that import "vscode"` | `grep_search` |
| `create a function in src/utils.ts that adds two numbers, then write a test for it` | `create_file` + multi-file edit |
| `the function in src/utils.ts has a bug, the addition returns the first arg twice. fix it.` | `read_file` + `edit_file` |
| `run the tests` | `run_terminal_cmd` |

If the model handles all five, it's a good fit for AIDev.

## Why I recommend Qwen2.5-Coder over alternatives

For *coding-specific* agent work, the Qwen2.5-Coder family currently has the best instruct-tuning + tool-use behavior of any open-weight model in the 7-14B range. DeepSeek-Coder-V2 is competitive but bigger. Llama 3.1 8B is more conversational but weaker at code. StarCoder2 is base-only. CodeLlama is older and tool-use behavior is unreliable.

For *general* agent work where code is one task among many, Llama-3.1-8B-Instruct is a solid alternative — slightly worse at code, slightly better at reasoning and following multi-step plans.

For *cloud-quality* on local hardware, Qwen2.5-Coder-32B-Instruct is the closest you'll get to Claude Sonnet on a single workstation today, but it's tight on 16 GB unified memory.

## Updating model recommendations

Open-model quality moves fast. This guide should be revisited every 3-6 months. The selection criteria above (instruct-tuned, ≥7B, supports tool calling, code-focused) will stay valid even as specific model recommendations change.
