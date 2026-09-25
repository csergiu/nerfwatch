// Every model NerfWatch can test: who serves it, the thinking levels it accepts, and its prices.
// Prices are list prices in USD per million tokens, September 2026. Check them before relying on them:
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing
//   xAI        https://docs.x.ai/developers/models
//   Meta       https://dev.meta.ai/docs/pricing-rate-limits
// OpenRouter models ("openrouter/...") aren't listed here: they're added at run time from
// OpenRouter's model list (src/providers/openrouter.ts), and their cost comes from OpenRouter itself.
// Our longest prompt is ~33k tokens, well below the long-context surcharges some providers add.

export type Provider = "anthropic" | "openai" | "xai" | "meta" | "openrouter";

type Price = { input: number; cachedInput: number; cacheWrite?: number; output: number };

export type ModelInfo = {
  provider: Provider;
  name: string;
  efforts: readonly string[]; // accepted --effort values; all models accept "low", the default
  price: Price;
  batch?: boolean; // OpenRouter models only: whether full runs can use its Batch API
};

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export const MODELS: Record<string, ModelInfo> = {
  "claude-opus-5": { provider: "anthropic", name: "Claude Opus 5", efforts: CLAUDE_EFFORTS, price: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 } },
  "claude-opus-5-5": { provider: "anthropic", name: "Claude Opus 5.5", efforts: CLAUDE_EFFORTS, price: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 } },
  "claude-sonnet-5": { provider: "anthropic", name: "Claude Sonnet 5", efforts: CLAUDE_EFFORTS, price: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 } },
  "claude-fable-5-1": { provider: "anthropic", name: "Claude Fable 5.1", efforts: CLAUDE_EFFORTS, price: { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 } },

  "gpt-6-astra": { provider: "openai", name: "GPT-6 Astra", efforts: ["low", "medium", "high", "xhigh", "max"], price: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 } },
  "gpt-6-sol": { provider: "openai", name: "GPT-6 Sol", efforts: ["none", "low", "medium", "high", "xhigh", "max"], price: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 } },
  "gpt-5.5": { provider: "openai", name: "GPT-5.5", efforts: ["none", "low", "medium", "high", "xhigh"], price: { input: 5, cachedInput: 0.5, output: 30 } },

  "grok-4.7": { provider: "xai", name: "Grok 4.7", efforts: GROK_EFFORTS, price: { input: 2, cachedInput: 0.5, output: 6 } },
  "grok-4.6": { provider: "xai", name: "Grok 4.6", efforts: GROK_EFFORTS, price: { input: 2, cachedInput: 0.5, output: 6 } },

  // Standard tier only. Meta's cheaper "-contributor" models may train on what you send,
  // which would put your private questions into Meta's training data.
  "muse-spark-1.3": { provider: "meta", name: "Muse Spark 1.3", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], price: { input: 1.25, cachedInput: 0.15, output: 4.25 } },
  "muse-spark-1.2": { provider: "meta", name: "Muse Spark 1.2", efforts: ["minimal", "low", "medium", "high", "xhigh"], price: { input: 1.25, cachedInput: 0.15, output: 4.25 } },
};

const BATCH_DISCOUNT = 0.5; // every provider we use a batch API for halves all token prices

export type TokenUsage = { input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number };

export function modelInfo(model: string): ModelInfo {
  const info = MODELS[model];
  if (!info) throw new Error(`Unknown model "${model}". Run ./nerf models to see the ones NerfWatch supports.`);
  return info;
}

// `input` is uncached input only; cache reads and writes are counted separately.
export function costUsd(model: string, usage: TokenUsage, batch: boolean): number {
  const p = modelInfo(model).price;
  const full =
    (usage.input * p.input +
      usage.cacheWrite * (p.cacheWrite ?? p.input) +
      usage.cacheRead * p.cachedInput +
      usage.output * p.output) /
    1_000_000;
  return batch ? full * BATCH_DISCOUNT : full;
}
