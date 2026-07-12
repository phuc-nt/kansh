// Approximate per-MTok pricing for the cost ESTIMATE in the digest panel.
// Prices from Anthropic docs as of 2026-07 (cache read ≈ 0.1× input; cache
// WRITE premium and intro discounts ignored — this is a ballpark, displayed
// as "ước tính"). Unknown model → null (UI shows tokens without $).

interface ModelPricing {
  pattern: RegExp;
  inPerMTok: number;
  outPerMTok: number;
  cacheReadPerMTok: number;
}

const PRICING: ModelPricing[] = [
  { pattern: /fable|mythos/, inPerMTok: 10, outPerMTok: 50, cacheReadPerMTok: 1.0 },
  { pattern: /opus/, inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5 },
  { pattern: /sonnet/, inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
  { pattern: /haiku/, inPerMTok: 1, outPerMTok: 5, cacheReadPerMTok: 0.1 },
];

export interface UsageTotals {
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
}

/** Estimated USD cost; null when the model has no known pricing. */
export function estimateCostUsd(model: string, usage: UsageTotals): number | null {
  const pricing = PRICING.find((p) => p.pattern.test(model));
  if (!pricing) return null;
  return (
    (usage.inTokens * pricing.inPerMTok +
      usage.outTokens * pricing.outPerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok) /
    1_000_000
  );
}
