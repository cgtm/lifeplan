# LLM Hosting Research: Alternatives to Local Ollama

**Prepared by Sage** | 23 April 2026

---

## Context

The lifeplan app uses Ollama + Mistral 7B in two places:

1. **Brain dump processing** (`processing.py`): Extracts tasks, people, knowledge items, goals, tags from free-text input. Falls back to regex if Ollama is unavailable. Timeout: 30s.
2. **Prompt generation** (`generate_prompts.py`): Analyses the full database state and generates 0-3 cross-cutting observations in Reed's voice. Falls back to skipping LLM analysis entirely. Timeout: 45s.

Both paths use `http://localhost:11434` and already handle failure gracefully. The regex fallback for brain dumps is functional but produces noticeably worse results (misses nuanced tasks, worse goal matching, no new tag suggestions). The prompt generation path simply produces no LLM-based observations when Ollama is down.

Usage pattern: low volume. A few brain dumps per day, prompt generation runs at most once per 12 hours. This is relevant because it means per-token API costs would be negligible.

---

## Option 1: Self-Hosted Ollama on a DigitalOcean Droplet

### DigitalOcean Droplet Specs and Pricing (April 2026)

| Droplet tier | vCPUs | RAM | SSD | Monthly cost |
|---|---|---|---|---|
| Basic $6 | 1 | 1 GB | 25 GB | $6 |
| Basic $12 | 1 | 2 GB | 50 GB | $12 |
| Basic $18 | 2 | 2 GB | 60 GB | $18 |
| Basic $24 | 2 | 4 GB | 80 GB | $24 |
| Basic $48 | 4 | 8 GB | 160 GB | $48 |
| CPU-optimised $42 | 2 | 4 GB | 25 GB | $42 |
| CPU-optimised $84 | 4 | 8 GB | 50 GB | $84 |

### Mistral 7B on a VPS: What Does It Need?

Mistral 7B (Q4_K_M quantisation, which is what Ollama uses by default) requires:

- **RAM**: ~4.5-5 GB just for model weights in memory, plus OS overhead. Realistically needs a machine with **8 GB RAM** to run comfortably, though it can technically squeeze into 6 GB with aggressive settings.
- **CPU**: Inference on CPU-only is slow. On a 4-vCPU shared droplet, expect **30-90 seconds per response** for the kind of prompts the app sends (the extraction prompt is ~1500 tokens in, ~500-1000 tokens out). On 2 vCPUs, double that.
- **Disk**: Mistral 7B Q4 is ~4.1 GB on disk. Ollama itself is small. Total disk need: ~10-15 GB.

**Verdict**: You would need the $48/month (4 vCPU, 8 GB RAM) droplet at minimum. Response times would be 30-90 seconds, which is marginal for the 30s timeout currently set in `processing.py` (would need to increase to 120s). The $24/month (4 GB) droplet cannot run Mistral 7B reliably -- it would OOM or swap to disk making it even slower.

**Cost**: $48/month = $576/year for a personal app. This is poor value.

### Could You Use a Smaller Model on a Cheaper Droplet?

Yes. This is worth considering.

---

## Option 2: Smaller Models on a Cheaper VPS

| Model | Parameters | Q4 Size (disk) | RAM needed | Quality for this task |
|---|---|---|---|---|
| **Mistral 7B** | 7B | 4.1 GB | ~5 GB | Good. Current baseline. |
| **Phi-3 Mini** (3.8B) | 3.8B | 2.2 GB | ~3 GB | Good. Microsoft's instruction-tuned model. Surprisingly capable for structured extraction. |
| **Gemma 2 2B** | 2.6B | 1.5 GB | ~2 GB | Decent. Google's small model. May struggle with the complex extraction prompt. |
| **Qwen2.5 3B** | 3B | 1.8 GB | ~2.5 GB | Good. Strong multilingual model, good at following structured output instructions. |
| **TinyLlama 1.1B** | 1.1B | 0.6 GB | ~1 GB | Poor. Too small for reliable JSON extraction from natural language. Would produce frequent parsing failures. |
| **Llama 3.2 3B** | 3B | 1.9 GB | ~2.5 GB | Good. Meta's latest small model. Strong instruction following. |
| **SmolLM2 1.7B** | 1.7B | 1.0 GB | ~1.5 GB | Marginal. Better than TinyLlama but still struggles with complex structured output. |

**Practical recommendation**: Phi-3 Mini or Qwen2.5 3B on the **$24/month droplet** (2 vCPU, 4 GB RAM). These models fit in ~3 GB RAM, leaving ~1 GB for the OS. Inference would take 15-40 seconds on 2 vCPUs for typical brain dump extraction. This is within the current timeout with some margin.

**However**: Quality will drop compared to Mistral 7B. The extraction prompt is demanding -- it asks for structured JSON with multiple entity types, confidence scores, and date resolution. In my assessment, Phi-3 Mini and Qwen2.5 3B would handle it ~80% as well as Mistral 7B. Gemma 2B and smaller models would produce noticeably more parsing failures and missed extractions.

**Cost**: $24/month = $288/year. Still expensive for marginal gains over the regex fallback.

---

## Option 3: Cloud LLM APIs

This is the most practical option for low-volume personal use.

### Cost Estimates

Based on the app's actual prompts:
- Brain dump extraction prompt: ~1,500 input tokens + ~800 output tokens per call
- Prompt generation: ~2,000 input tokens + ~500 output tokens per call
- Usage: ~5 brain dumps/day + 2 prompt generation runs/day = ~7 calls/day

| Provider | Model | Input cost | Output cost | Daily cost (7 calls) | Monthly cost |
|---|---|---|---|---|---|
| **Groq** | Llama 3.1 8B | $0.05/M tok | $0.08/M tok | $0.0009 | **$0.03** |
| **Groq** | Llama 3.3 70B | $0.59/M tok | $0.79/M tok | $0.010 | **$0.30** |
| **Together.ai** | Llama 3.1 8B | $0.18/M tok | $0.18/M tok | $0.003 | **$0.09** |
| **Together.ai** | Mistral 7B | $0.20/M tok | $0.20/M tok | $0.003 | **$0.10** |
| **Mistral API** | Mistral Small (latest) | $0.10/M tok | $0.30/M tok | $0.003 | **$0.09** |
| **Mistral API** | Mistral Large | $2.00/M tok | $6.00/M tok | $0.047 | **$1.40** |
| **OpenAI** | GPT-4o-mini | $0.15/M tok | $0.60/M tok | $0.006 | **$0.17** |
| **OpenAI** | GPT-4o | $2.50/M tok | $10.00/M tok | $0.078 | **$2.35** |
| **Anthropic** | Claude 3.5 Haiku | $0.80/M tok | $4.00/M tok | $0.035 | **$1.04** |
| **Anthropic** | Claude Sonnet 4 | $3.00/M tok | $15.00/M tok | $0.128 | **$3.84** |
| **Google** | Gemini 2.0 Flash | $0.10/M tok | $0.40/M tok | $0.004 | **$0.12** |

**Key observations**:
- At this usage level, every single cloud API costs under $4/month. Most are under $0.30/month.
- **Groq** with Llama 3.1 8B is essentially free ($0.03/month) and has very fast inference (sub-second).
- **GPT-4o-mini** at $0.17/month would likely produce better extraction quality than Mistral 7B local.
- Even the most expensive option (Claude Sonnet 4 at $3.84/month) is dramatically cheaper than any self-hosted VPS.
- Most providers offer free tiers or credits that would cover this usage entirely. Groq has a generous free tier. Google's Gemini has a free tier of 15 RPM.

### Quality Comparison for Structured JSON Extraction

For the specific task of extracting structured JSON from natural language brain dumps:

1. **Best quality**: Claude Sonnet 4, GPT-4o -- but overkill and unnecessary cost
2. **Best value**: GPT-4o-mini, Groq Llama 3.3 70B, Gemini 2.0 Flash -- excellent at structured extraction, pennies per month
3. **Good enough**: Groq Llama 3.1 8B, Together.ai Mistral 7B -- comparable to current local Mistral 7B, essentially free
4. **Avoid**: TinyLlama or sub-3B models via API -- not worth the quality tradeoff when larger models cost the same

---

## Option 4: Hybrid Fallback Chain (Recommended)

The app already has a two-tier architecture (LLM -> regex fallback). The optimal approach extends this to a multi-tier chain:

```
1. Local Ollama (if reachable)  -- free, fast, works when Mac is on
      |
      v  (fails)
2. Cloud API (Groq / GPT-4o-mini / Gemini Flash)  -- $0.03-0.17/month
      |
      v  (fails)
3. Regex fallback  -- free, always works, lower quality
```

### Why This Order?

- **Local Ollama first**: Zero cost, fastest latency when available, no API key dependency. When Cam is using his Mac, the app gets the same quality it has today.
- **Cloud API second**: Covers the case where the Mac is off/away. At $0.03-0.17/month, the cost is negligible. Provides better results than regex.
- **Regex third**: Already implemented. Catches edge cases where both LLM paths fail (network issues, API outage, etc.).

### Implementation Complexity

Low. The current code calls `_call_ollama()` and checks for `None` return. Adding a cloud API step requires:

1. A new function `_call_cloud_llm(prompt)` that hits the chosen API
2. A config value for the API key (environment variable)
3. Modify `process_brain_dump_llm()` to try cloud API before returning `None`
4. Same pattern for `call_ollama_for_patterns()` in `generate_prompts.py`

Estimated implementation effort: 1-2 hours for Lumen.

### Provider Recommendation for Cloud Tier

**Primary recommendation: Groq with Llama 3.1 8B or Llama 3.3 70B**

Reasons:
- Extremely fast inference (sub-second response times)
- Essentially free at this usage level ($0.03-0.30/month)
- Good at structured JSON output
- Simple REST API, no SDK needed (the app currently uses raw `urllib` -- Groq's API is OpenAI-compatible)
- Generous free tier exists

**Runner-up: Google Gemini 2.0 Flash**
- Free tier covers this usage entirely (15 RPM)
- Excellent at structured extraction
- $0.12/month if free tier expires

**If quality matters most: OpenAI GPT-4o-mini**
- $0.17/month
- Best-in-class for structured JSON extraction at this price point
- Most mature API ecosystem

---

## Option 5: Tailscale Tunnel to Mac (Not Recommended as Primary)

Cam could expose his Mac's Ollama over Tailscale and point the droplet-hosted app at it.

**Pros**:
- Zero additional cost (Tailscale free tier covers personal use)
- Same quality as current local setup
- No API keys to manage

**Cons**:
- Defeats the purpose -- if the Mac is off, it does not work
- Adds Tailscale as a dependency to the deployment
- Ollama needs to bind to `0.0.0.0` instead of `127.0.0.1` (security consideration)
- Network latency adds to already-slow CPU inference times
- More fragile than a cloud API call

**Verdict**: This could be useful as an *additional* tier in the fallback chain (try Tailscale Ollama first, then cloud API, then regex), but it should not be the primary solution because it does not solve the core problem of Mac-offline availability.

---

## Cost Comparison Summary

| Option | Monthly cost | Quality | Availability | Complexity |
|---|---|---|---|---|
| Self-hosted Mistral 7B ($48 droplet) | $48 | Same as today | Always on | Medium |
| Self-hosted Phi-3 Mini ($24 droplet) | $24 | ~80% of today | Always on | Medium |
| Cloud API (Groq Llama 8B) | ~$0.03 | Same as today | Always on | Low |
| Cloud API (GPT-4o-mini) | ~$0.17 | Better than today | Always on | Low |
| Cloud API (Gemini Flash free tier) | $0 | Same as or better | Always on | Low |
| Tailscale to Mac | $0 | Same as today | Mac must be on | Medium |
| Regex only (current fallback) | $0 | Lower than today | Always on | Already done |
| **Hybrid: local + cloud + regex** | **~$0.03-0.17** | **Best of all** | **Always on** | **Low** |

---

## Recommendation

**Implement the hybrid fallback chain (Option 4) using Groq as the cloud tier.**

Rationale:
1. Costs essentially nothing ($0.03/month at current usage)
2. Solves the Mac-offline problem completely
3. Low implementation effort -- the fallback pattern already exists in the code
4. No infrastructure to maintain (no VPS to patch, no model updates to manage)
5. Preserves the free, fast local path when the Mac is available
6. Regex fallback remains as a safety net

Self-hosting an LLM on a VPS is unjustifiable at this usage level. The $24-48/month for a droplet buys you slower, potentially lower-quality inference than a cloud API that costs pennies. The only argument for self-hosting would be data privacy, but the brain dump content is personal notes -- Groq and similar providers do not train on API data, and the app already stores everything in a local SQLite database.

### Next Steps for Lumen

1. Add a `CLOUD_LLM_PROVIDER` and `CLOUD_LLM_API_KEY` environment variable
2. Create a `_call_cloud_llm(prompt)` function in `processing.py` (and equivalent in `generate_prompts.py`)
3. Update the fallback chain: `_call_ollama()` -> `_call_cloud_llm()` -> `None` (regex)
4. The existing prompt format should work with minimal modification for Groq/OpenAI-compatible APIs (the prompt already asks for JSON output)
5. Add a UI indicator showing which extraction method was used (already tracked via `extraction_method` field)
