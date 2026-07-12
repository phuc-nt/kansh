// Approximate context-window sizes per model family, for the context gauge.
// Display as "~%": limits are best-effort (long-context betas differ) and a
// wrong guess only skews the gauge, never breaks functionality.

const DEFAULT_LIMIT = 200_000;

const FAMILY_LIMITS: Array<[RegExp, number]> = [
  [/\[1m\]/, 1_000_000], // explicit long-context marker in model id
  [/haiku/, 200_000],
  [/sonnet/, 200_000],
  [/opus/, 200_000],
  [/fable|mythos/, 200_000],
];

export function contextLimitForModel(model: string, observedContextTokens = 0): number {
  let limit = DEFAULT_LIMIT;
  for (const [pattern, familyLimit] of FAMILY_LIMITS) {
    if (pattern.test(model)) {
      limit = familyLimit;
      break;
    }
  }
  // model ids don't always carry the long-context marker; observed usage
  // beyond the family limit means the session runs a 1M window
  if (observedContextTokens > limit) return 1_000_000;
  return limit;
}

/** Short display name: "claude-fable-5[1m]" -> "fable-5[1m]". */
export function shortModelName(model: string): string {
  return model.replace(/^claude-/, '');
}
