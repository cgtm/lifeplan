# LLM API Providers Research — Cheap/Free Options for Low-Volume Personal App

**Researcher:** Sage | **Date:** 2026-04-23
**Use case:** Brain dump processing and structured JSON extraction from natural language, a few calls per day. Currently uses Mistral 7B via Ollama locally.

---

## Executive Summary

For Cam's use case (a few API calls per day, structured JSON output from natural language), the cost will be negligible with almost any provider. The real differentiators are: **free tier generosity**, **structured output support**, **API simplicity**, and **reliability**. My top recommendations are at the bottom.

---

## Provider Comparison Table

Prices are per million tokens (input/output) as of April 2026. "Structured JSON" means native JSON mode or JSON Schema enforcement via the API.

| Provider | Cheapest Suitable Model | Input $/M | Output $/M | Free Tier | Structured JSON | API Compat | Notes |
|----------|------------------------|-----------|------------|-----------|-----------------|------------|-------|
| **Google AI Studio** | Gemini 2.5 Flash-Lite | $0.10 | $0.40 | 1,500 req/day, no CC | Yes (JSON Schema) | REST, SDKs | Best free tier by far |
| **Mistral** | Ministral 8B | $0.10 | $0.10 | 1B tokens/mo, 2 RPM, no CC | Yes (JSON mode) | REST, OpenAI-compat, SDKs | Generous free tier, all models accessible |
| **OpenAI** | GPT-4.1 Nano | $0.10 | $0.40 | Very limited (GPT-3.5 only, 3 RPM) | Yes (Structured Outputs) | REST, SDKs | Best structured output support, but poor free tier |
| **OpenAI** | GPT-4o-mini | $0.15 | $0.60 | See above | Yes | REST, SDKs | Proven, widely documented |
| **Cerebras** | Llama 3.3 70B | $0.10 (est.) | $0.10 (est.) | 1M tokens/day, 30 RPM, no CC | Yes (via Groq-style JSON mode) | OpenAI-compat | Extremely fast inference, good free tier |
| **Groq** | Llama 3.1 8B | $0.05 | $0.08 | 1,000 req/day, 30 RPM, no CC | Yes (JSON Schema, strict mode) | OpenAI-compat, SDKs | Ultra-fast. Cam has reservations. |
| **Together.ai** | Llama 3.1 8B | $0.10 | $0.10 (est.) | Free credits at signup | Yes (JSON mode) | OpenAI-compat, REST | Wide model selection, good docs |
| **Fireworks.ai** | Qwen3 8B / Marin 8B | $0.18-$0.20 | $0.18-$0.20 | $1 starter credits | Yes (JSON mode) | OpenAI-compat, REST | Very fast inference, 50+ models |
| **DeepInfra** | Llama 3.1 8B / Mistral 7B | $0.03-$0.06 | $0.03-$0.06 | No free tier (pay-as-you-go) | Yes (JSON mode) | OpenAI-compat | Rock-bottom pricing |
| **DeepSeek (direct)** | DeepSeek V3 | $0.27 | $0.41 | 1M free tokens for new accounts | Yes (JSON output) | OpenAI-compat, REST | Excellent quality, cache hits at 10% rate |
| **Novita AI** | Llama 3.1 8B | $0.02 | $0.02 | No free tier | Yes (JSON mode) | OpenAI-compat | Cheapest per-token, less known |
| **OpenRouter** | Various :free models | $0.00 | $0.00 | 20+ free models (rate-limited) | Depends on model | OpenAI-compat | Aggregator; great for testing multiple models |
| **Cloudflare Workers AI** | Llama/Mistral 7B | ~$0.011/1K neurons | (included) | 10,000 neurons/day | Yes (JSON mode) | REST, Workers SDK | Edge-based, Cloudflare ecosystem |
| **SambaNova** | gpt-oss-120B | $0.31 | $0.31 | $5 credit + rate-limited free tier | Yes | OpenAI-compat | Fast inference on custom silicon |
| **Hugging Face** | Various OSS models | Varies by provider | Varies | $0.10/mo free credits | Depends on model | REST, HF SDKs | Hub for 200+ models; thin free tier |
| **SiliconFlow** | Llama 3.1 8B | $0.06 | $0.06 | $1 free credits | Yes (JSON mode) | OpenAI-compat | Good price-perf, less Western presence |
| **Anthropic** | Claude Haiku 4.5 | $1.00 | $5.00 | None (pay-as-you-go) | Yes (tool use / JSON) | REST, SDKs | High quality but expensive for this use case |
| **Perplexity** | Sonar | $1.00 | $1.00 | None | Limited | REST | Search-augmented; overkill here |
| **Replicate** | Various OSS | Varies (time-based) | Varies | None | Depends on model | REST | Per-second billing; expensive vs alternatives |
| **Lambda Labs** | Llama 3.3 70B | $0.20 | $0.20 | None | Limited | REST | Inference API may be winding down |
| **Lepton AI** | Various | $0.07-$0.50 | $0.07-$0.50 | Unknown | Limited | REST | Limited info available |

---

## Detailed Provider Profiles

### Tier 1: Best Value for This Use Case

#### Google AI Studio (Gemini)
- **URL:** https://ai.google.dev
- **Best model:** Gemini 2.5 Flash-Lite ($0.10/$0.40) or Gemini 2.5 Flash ($0.15/$0.60, recently adjusted)
- **Free tier:** 1,500 requests/day on Flash models, no credit card required. This alone could run Cam's app indefinitely at zero cost.
- **Structured JSON:** Full JSON Schema support via `response_mime_type: "application/json"` with schema enforcement
- **API:** REST with Google SDKs; also available via OpenRouter and Vertex AI
- **Pros:** Most generous free tier in the industry. 1M token context window. Multimodal. Excellent for structured extraction.
- **Cons:** Google ecosystem lock-in concerns. April 2026 reduced quotas on Pro models. Occasional schema enforcement quirks.

#### Mistral (Direct API)
- **URL:** https://mistral.ai
- **Best models:** Ministral 8B ($0.10/$0.10), Mistral Nemo ($0.02 input), Mistral Small ($0.20/$0.60)
- **Free tier:** "Experiment" plan gives access to ALL models (including Mistral Large) at 2 RPM, 500K TPM, 1B tokens/month. No credit card required.
- **Structured JSON:** Yes, JSON mode supported across models
- **API:** REST, OpenAI-compatible endpoint, official Python/JS SDKs
- **Pros:** Cam already uses Mistral 7B locally -- direct familiarity with the model family. Free tier is extremely generous for low-volume use. European company (data sovereignty). All models accessible on free tier.
- **Cons:** 2 RPM limit on free tier (fine for a few calls/day). Smaller ecosystem than OpenAI/Google.

#### Cerebras
- **URL:** https://cerebras.ai
- **Best models:** Llama 3.3 70B, Qwen3 32B (free tier includes these)
- **Free tier:** 1M tokens/day, 30 RPM, no credit card. Includes Llama 3.3 70B, Qwen3 32B, Qwen3 235B, and GPT-OSS 120B.
- **Structured JSON:** Supports JSON mode via OpenAI-compatible API
- **API:** OpenAI-compatible REST API
- **Pros:** Blazing fast inference (custom wafer-scale chips). Very generous free tier with large models. No credit card needed.
- **Cons:** Smaller model selection. Less established as a long-term API provider. Custom silicon means they could pivot.

#### OpenAI (GPT-4.1 Nano)
- **URL:** https://platform.openai.com
- **Best model:** GPT-4.1 Nano ($0.10/$0.40), GPT-4o-mini ($0.15/$0.60)
- **Free tier:** Very limited -- GPT-3.5 only at 3 RPM. Realistically, you need to pay.
- **Structured JSON:** Industry-leading Structured Outputs with JSON Schema enforcement. Function calling. Most reliable JSON output of any provider.
- **API:** The standard that everyone else copies. Massive ecosystem, every library supports it.
- **Pros:** Best structured output implementation. Enormous ecosystem. GPT-4.1 Nano at $0.10/M input is genuinely cheap. Batch API at 50% off. 1M context window.
- **Cons:** No meaningful free tier. Requires credit card and billing. At a few calls/day, monthly cost would be pennies but you still need to set up billing.

### Tier 2: Strong Alternatives

#### Together.ai
- **URL:** https://together.ai
- **Best models:** Llama 3.1 8B (~$0.10/M), Llama 4 Maverick ($0.27/$0.85), many Qwen variants
- **Free tier:** Free credits at signup (amount varies). No ongoing free tier.
- **Structured JSON:** JSON mode supported on most models
- **API:** OpenAI-compatible, REST, Python/JS SDKs
- **Pros:** 200+ models. Very competitive pricing. Good documentation. Active community.
- **Cons:** No permanent free tier. Signup credits run out.

#### Fireworks.ai
- **URL:** https://fireworks.ai
- **Best models:** Qwen3 8B ($0.20/M), Marin 8B ($0.18/M input)
- **Free tier:** $1 in starter credits
- **Structured JSON:** JSON mode supported; known for fast structured generation
- **API:** OpenAI-compatible, REST
- **Pros:** Very fast inference. Grammar-constrained generation (excellent for JSON). 50+ models. Cached inputs at 50% off.
- **Cons:** Tiny free credits. Mid-range pricing vs cheapest options.

#### DeepInfra
- **URL:** https://deepinfra.com
- **Best models:** Llama 3.1 8B ($0.03-$0.06/M), Mistral 7B ($0.06/M)
- **Free tier:** None (pure pay-as-you-go)
- **Structured JSON:** JSON mode on supported models
- **API:** OpenAI-compatible, REST
- **Pros:** Among the cheapest per-token pricing anywhere. Wide model selection. No minimum.
- **Cons:** No free tier. Less documentation than bigger players.

#### OpenRouter (Aggregator)
- **URL:** https://openrouter.ai
- **Best approach:** Use `:free` suffix models (Mistral 7B, Llama 3.1 8B, Gemma 2 9B, etc.) for zero cost
- **Free tier:** 20+ free models with 20 req/min, 200 req/day limits
- **Structured JSON:** Depends on the underlying model
- **API:** OpenAI-compatible (single API key routes to any provider/model)
- **Pros:** One API key to test every model and provider. Free models available. No markup on paid inference (5.5% fee on credit purchase). Great for comparison shopping.
- **Cons:** Added abstraction layer. Free models have tight rate limits. Less control over routing.

#### DeepSeek (Direct API)
- **URL:** https://api-docs.deepseek.com
- **Best model:** DeepSeek V3 ($0.27/$0.41), DeepSeek V4 ($0.30/$0.50)
- **Free tier:** 1M tokens free for new accounts
- **Structured JSON:** JSON output supported
- **API:** OpenAI-compatible, REST
- **Pros:** Excellent quality-to-price ratio. Cache hits billed at 10% of standard rate. No minimum commitment.
- **Cons:** China-based company (data routing concerns for some users). Periodic availability issues reported.

#### Novita AI
- **URL:** https://novita.ai
- **Best models:** Llama 3.1 8B ($0.02/M), Qwen3 4B ($0.03/M)
- **Free tier:** None
- **Structured JSON:** JSON mode via OpenAI-compatible API
- **API:** OpenAI-compatible
- **Pros:** Possibly the cheapest per-token pricing available. No rate limits. Batch inference at 50% off.
- **Cons:** Lesser-known provider. Reliability and longevity unproven. No free tier.

### Tier 3: Viable but Less Ideal for This Use Case

#### Cloudflare Workers AI
- **URL:** https://developers.cloudflare.com/workers-ai
- **Free tier:** 10,000 neurons/day (enough for light use)
- **Pros:** Edge-based, low latency. Good if already in Cloudflare ecosystem.
- **Cons:** Neuron-based billing is confusing. Limited model selection. More suited to apps already on Cloudflare.

#### SambaNova
- **URL:** https://cloud.sambanova.ai
- **Free tier:** $5 credit + ongoing rate-limited free tier
- **Pros:** Custom silicon, fast inference. OpenAI-compatible.
- **Cons:** Limited model selection. Less known.

#### SiliconFlow
- **URL:** https://siliconflow.com
- **Free tier:** $1 in credits
- **Pros:** Very competitive pricing. Fast inference.
- **Cons:** Primarily Chinese market. Limited Western documentation.

#### Hugging Face Inference
- **URL:** https://huggingface.co
- **Free tier:** $0.10/month free credits (very thin)
- **Pros:** Access to 200+ models. Great ecosystem.
- **Cons:** Free tier is barely usable. Cold starts. No SLA.

#### Groq (for reference -- Cam has reservations)
- **URL:** https://groq.com
- **Best models:** Llama 3.1 8B ($0.05/$0.08), Llama 3.3 70B
- **Free tier:** 1,000 req/day, 30 RPM, no credit card
- **Structured JSON:** Excellent -- strict JSON Schema with constrained decoding
- **Pros:** Fastest inference anywhere. Good free tier. Excellent structured output.
- **Cons:** Cam has specific reasons for avoiding Groq.

### Tier 4: Not Recommended for This Use Case

| Provider | Reason |
|----------|--------|
| **Anthropic (Haiku 4.5)** | $1/$5 per M tokens -- 10x more expensive than alternatives. No free tier. Overkill for extraction. |
| **Perplexity** | $1/$1 per M tokens. Search-augmented model -- wrong tool for structured extraction. |
| **Replicate** | Per-second billing model is expensive for LLM inference. Better for image/media models. |
| **Lambda Labs** | Inference API appears to be winding down. Primarily a GPU cloud provider. |
| **Lepton AI** | Limited current information. Mid-range pricing. |
| **Anyscale Endpoints** | Pivoted to enterprise platform. No longer competitive as a consumer API. |
| **OVHcloud AI Endpoints** | Opaque pricing. Enterprise-focused. |

---

## Recommendation: Ranked for Cam's Use Case

**Criteria weighted:** Free/cheap for a few calls/day > reliable structured JSON > simple API > not Groq.

### 1. Google AI Studio (Gemini 2.5 Flash) -- BEST OVERALL
The free tier alone (1,500 req/day) will run this app forever at zero cost. JSON Schema support is solid. No credit card needed to start. The only real risk is Google's habit of changing things, but for a personal app this is a non-issue.

### 2. Mistral (Direct API) -- BEST FAMILIARITY FIT
Cam already runs Mistral 7B locally. The Mistral API Experiment plan gives free access to ALL their models (including Mistral Small and Large) at 2 RPM with no credit card. For a few calls per day, 2 RPM is more than enough. Easiest migration path from the current Ollama setup.

### 3. Cerebras -- BEST FREE TIER FOR LARGE MODELS
Free access to Llama 3.3 70B and Qwen3 32B at 1M tokens/day is remarkable. If the extraction task benefits from a larger, more capable model, Cerebras lets you use 70B+ parameter models for free.

### 4. OpenAI GPT-4.1 Nano -- BEST STRUCTURED OUTPUT
If structured JSON reliability is the top priority, nothing beats OpenAI's Structured Outputs implementation. GPT-4.1 Nano at $0.10/M input would cost literal pennies per month at this volume. Downside: requires setting up billing (no meaningful free tier).

### 5. OpenRouter (with free models) -- BEST FOR EXPERIMENTATION
Use the free tier to test Mistral 7B, Llama 3.1 8B, and Gemma 2 9B through a single API key. Useful for finding which model handles brain dump extraction best before committing to a provider.

---

## Cost Estimate for Cam's Usage

Assuming ~10 calls/day, ~2,000 tokens input and ~500 tokens output per call:
- **Daily tokens:** ~20,000 input + ~5,000 output = 25,000 total
- **Monthly tokens:** ~750,000 total (~0.75M)

| Provider | Monthly Cost |
|----------|-------------|
| Google Gemini Flash-Lite (free tier) | **$0.00** |
| Mistral Experiment (free tier) | **$0.00** |
| Cerebras (free tier) | **$0.00** |
| OpenRouter free models | **$0.00** |
| GPT-4.1 Nano (paid) | **~$0.0004** (less than a tenth of a penny) |
| DeepInfra Llama 8B | **~$0.00005** |
| Together.ai Llama 8B | **~$0.00008** |

At this volume, even the paid options are effectively free. The question is really about **which free tier requires the least setup friction** and **which model produces the most reliable structured JSON** for brain dump extraction.

---

## Implementation Note

All of the top recommendations (Google, Mistral, Cerebras, OpenRouter) offer OpenAI-compatible APIs. This means the app can use a single HTTP client pattern and switch providers by changing the base URL and API key. Consider building the integration with a configurable provider so Cam can switch without code changes.

---

## Sources

- [Together.ai Pricing](https://www.together.ai/pricing)
- [Fireworks.ai Pricing](https://fireworks.ai/pricing)
- [Mistral AI Pricing](https://mistral.ai/pricing)
- [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)
- [Google Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Cerebras Pricing](https://www.cerebras.ai/pricing)
- [DeepInfra Pricing](https://deepinfra.com/pricing)
- [OpenRouter Pricing](https://openrouter.ai/pricing)
- [Groq Pricing](https://groq.com/pricing)
- [Replicate Pricing](https://replicate.com/pricing)
- [Perplexity Pricing](https://docs.perplexity.ai/docs/getting-started/pricing)
- [Novita AI Pricing](https://novita.ai/pricing)
- [SambaNova Pricing](https://cloud.sambanova.ai/plans/pricing)
- [Cloudflare Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Hugging Face Pricing](https://huggingface.co/pricing)
- [SiliconFlow Pricing](https://www.siliconflow.com/pricing)
- [DeepSeek API Pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [Groq Structured Outputs Docs](https://console.groq.com/docs/structured-outputs)
- [Gemini Structured Output](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Free LLM API Comparison (TokenMix)](https://tokenmix.ai/blog/free-llm-api)
- [LLM API Pricing Comparison (PricePerToken)](https://pricepertoken.com/)
- [Free AI Inference Providers 2026 (Awesome Agents)](https://awesomeagents.ai/tools/free-ai-inference-providers-2026/)
