# Model Capability Guide for Champ

> Last updated: 2026-05-12

This guide answers the question: **"Can Champ do X with model Y?"** — with honest assessments based on model size and architecture.

---

## Can Champ create files and design documents?

**Yes.** Champ has a fully-wired `create_file` tool. In agent mode it will:

1. Reason through the task
2. Call `create_file` with the generated content
3. The file lands on disk — identical behaviour to Claude or Cursor

The file creation plumbing is the same regardless of the underlying model. The variable is **content quality**, which is determined entirely by the model.

---

## Example: Mobile App CI/CD Architecture Document with Mermaid Diagrams

A representative task: *"Create a design document with Mermaid diagrams for a mobile app CI/CD pipeline."*

| Model | Mermaid quality | Architecture depth | Overall |
|-------|----------------|--------------------|---------|
| **llama3:3b** | ❌ Poor — frequently produces broken Mermaid syntax; missing nodes, wrong edge syntax | Shallow and generic | Not recommended for structured docs |
| **qwen3:8b** | ⚠️ Decent — simple flowcharts work reliably; sequence/state diagrams occasionally break | Reasonable for common CI/CD patterns | Functional first draft; expect 1–2 manual fixes |
| **gemma4:27b** | ✅ Good — produces syntactically correct diagrams with proper labels | Solid architecture reasoning | Close to frontier model quality |
| **gemma4:4b** | ⚠️ Moderate — similar to qwen3:8b | Limited depth | Functional but shallow |
| **Claude Sonnet / GPT-4** | ✅ Excellent | Deep, multi-diagram, accurate | Gold standard |

### Recommended approach with local models

1. **Use `plan` mode first** — ask Champ to outline sections and diagram types, review the plan
2. **Switch to `agent` mode** — let it generate and write the file
3. **Use qwen3:8b or gemma4:27b** — not llama3B for structured output tasks
4. **Expect one revision pass** — the file will be created; a diagram or two may need manual syntax correction

---

## Model Capability Matrix

### By task type

| Task | Min recommended | Notes |
|------|----------------|-------|
| Simple Q&A / explain code | Any model (3B+) | Even small models handle this well |
| Read file + summarise | 3B+ | Works fine |
| Edit a specific function | 7B+ | Smaller models hallucinate surrounding code |
| Create a new file from scratch | 7B+ | 3B models produce low-quality content |
| Multi-file refactor | 14B+ | Needs strong reasoning to track cross-file changes |
| Architecture / design docs | 7B+ (qwen3, gemma4) | Mermaid syntax requires structured output capability |
| Complex Mermaid diagrams (sequence, state, ER) | 14B+ or qwen3:8b+ | Smaller models frequently produce broken syntax |
| Test generation | 7B+ | 3B models miss edge cases badly |
| Debugging across multiple files | 14B+ | Needs strong chain-of-thought |

### By model

| Model | Context | Tool use | Image | Code quality | Doc generation |
|-------|---------|----------|-------|-------------|----------------|
| llama3.2:3b | 128K | ⚠️ Prompt-based | ❌ | ⚠️ Basic | ❌ Poor |
| llama3.1:8b | 128K | ⚠️ Prompt-based | ❌ | ✅ Good | ⚠️ Adequate |
| qwen3:8b | 40K | ✅ Native (Ollama) | ❌ | ✅ Good | ✅ Good |
| qwen2.5-coder:7b | 32K | ⚠️ Prompt-based | ❌ | ✅ Excellent | ⚠️ Adequate |
| gemma4:4b | 128K | ⚠️ Prompt-based | ✅ | ⚠️ Adequate | ⚠️ Adequate |
| gemma4:27b | 128K | ⚠️ Prompt-based | ✅ | ✅ Excellent | ✅ Good |
| mistral:7b | 32K | ⚠️ Prompt-based | ❌ | ✅ Good | ⚠️ Adequate |
| codestral:22b | 32K | ⚠️ Prompt-based | ❌ | ✅ Excellent | ✅ Good |
| Claude Sonnet 4 | 200K | ✅ Native | ✅ | ✅ Excellent | ✅ Excellent |
| GPT-4o | 128K | ✅ Native | ✅ | ✅ Excellent | ✅ Excellent |
| Gemini 1.5 Pro | 1M | ✅ Native | ✅ | ✅ Excellent | ✅ Excellent |

> **Tool use:** Native = model was trained on function-calling format (more reliable). Prompt-based = Champ injects tool definitions as XML and parses responses (works, but more fragile).

---

## Why local models underperform on structured output

1. **Parameter count** — 3B–8B models have fewer "reasoning circuits" than 70B+ models or API frontier models. Mermaid diagrams require strict syntax adherence which smaller models fail at.

2. **Training data** — Many smaller models have limited Mermaid/PlantUML training data compared to frontier models.

3. **Prompt-based tool calling** — Local models that don't natively support function calling use XML-based prompting. This adds parsing overhead and failure modes that native tool calling doesn't have.

4. **Context window** — Complex architecture docs require holding many constraints in context simultaneously. Smaller context windows (8K–32K) on older models limit this.

---

## Recommended Local Model Stack (as of 2026)

| Use case | Recommended model | Why |
|----------|------------------|-----|
| General coding agent | qwen3:8b | Best tool-use reliability + code quality at 8B |
| Autocomplete (FIM) | qwen2.5-coder:1.5b | Fast, accurate, low VRAM |
| Architecture / docs | qwen3:8b or gemma4:27b | Structured output quality |
| Vision tasks (screenshot analysis) | gemma4:4b+ | Only local model family with image support |
| Embedding / @Codebase | nomic-embed-text or mxbai-embed-large | Purpose-built for retrieval |
| Low-VRAM machines (4GB) | qwen3:8b (Q4 quant) or qwen2.5-coder:7b (Q4) | Fits in 4GB with Q4 quantisation |

---

## Hardware requirements

| VRAM | Max usable model size | Recommended |
|------|----------------------|-------------|
| 4 GB | 7–8B @ Q4 quantised | qwen3:8b:q4_0 |
| 8 GB | 8B @ Q8 or 13B @ Q4 | qwen3:8b or llama3.1:8b |
| 12 GB | 14B @ Q4 or 13B @ Q8 | codestral:22b @ Q4 |
| 16 GB | 22B @ Q4 | codestral:22b |
| 24 GB+ | 27B @ Q8 | gemma4:27b or qwen2.5-coder:32b |

---

## Gap vs Claude / Cursor

| Capability | Champ + qwen3:8b | Claude / Cursor |
|-----------|-----------------|-----------------|
| File creation | ✅ Identical | ✅ |
| Simple code edits | ✅ Good | ✅ Excellent |
| Multi-file refactor | ⚠️ Functional | ✅ Reliable |
| Architecture docs | ⚠️ First draft | ✅ Production-ready |
| Complex Mermaid | ⚠️ Needs fixes | ✅ Correct first time |
| Test generation | ⚠️ Adequate | ✅ Comprehensive |
| Debugging | ⚠️ Slow | ✅ Fast |
| **Cost** | **Free (local)** | **$20–$200/month** |
| **Privacy** | **100% local** | **Cloud (data sent)** |
| **Offline** | **✅ Yes** | **❌ No** |

**Bottom line:** For teams with privacy requirements or cost constraints, Champ with a capable local model (qwen3:8b, gemma4:27b) covers 70–80% of daily coding assistant tasks. The remaining 20–30% — complex architecture reasoning, large multi-file refactors, subtle bug analysis — still benefits from frontier API models.
