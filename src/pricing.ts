// Anthropic list prices in USD per million tokens (mid-2026).
// Check the pricing page before relying on these: https://platform.claude.com/docs/en/about-claude/pricing
type Price = { input: number; output: number; cacheRead: number };

const PRICES: Record<string, Price> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute cache
const BATCH_DISCOUNT = 0.5;

export type TokenUsage = { input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number };

export function priceFor(model: string): Price {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for "${model}". Add it to src/pricing.ts.`);
  return price;
}

export function costUsd(model: string, usage: TokenUsage, batch: boolean): number {
  const p = priceFor(model);
  const full =
    (usage.input * p.input +
      usage.cacheWrite * p.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheRead * p.cacheRead +
      usage.output * p.output) /
    1_000_000;
  return batch ? full * BATCH_DISCOUNT : full;
}
