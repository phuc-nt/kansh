// Digest aggregation fixtures: per-project rollup, cost estimation with
// unknown models, hottest-project ordering, active-time merging.

import { describe, expect, test } from 'bun:test';
import type { SessionSnapshot } from '../shared/normalized-event-types';
import { aggregateDigest } from './digest-aggregation';
import { estimateCostUsd } from '../shared/model-pricing';

const T0 = 1700000000000;
let uid = 0;
const session = (extra: Partial<SessionSnapshot>): SessionSnapshot => ({
  sessionId: `s${++uid}`,
  project: 'p',
  cwd: '/tmp/proj-a',
  slug: '',
  entrypoint: 'cli',
  status: 'running',
  startedAt: new Date(T0).toISOString(),
  lastActivityAt: new Date(T0).toISOString(),
  model: 'claude-fable-5',
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalTokensCacheRead: 0,
  contextTokens: 0,
  errorStreak: 0,
  events: [],
  ...extra,
});

describe('estimateCostUsd', () => {
  test('known model computes in/out/cacheRead', () => {
    // fable-5: $10 in, $50 out, $1 cacheRead per MTok
    const cost = estimateCostUsd('claude-fable-5', {
      inTokens: 1_000_000,
      outTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBe(61);
  });

  test('unknown model returns null', () => {
    expect(estimateCostUsd('mystery-model-9', { inTokens: 1, outTokens: 1, cacheReadTokens: 1 })).toBeNull();
  });
});

describe('aggregateDigest', () => {
  test('rolls up per project, orders by total tokens, picks hottest', () => {
    const digest = aggregateDigest([
      session({ cwd: '/w/alpha', totalTokensIn: 100, totalTokensOut: 100 }),
      session({ cwd: '/w/alpha', totalTokensIn: 50, totalTokensOut: 0 }),
      session({ cwd: '/w/beta', totalTokensIn: 1000, totalTokensOut: 1000 }),
    ]);
    expect(digest.sessionCount).toBe(3);
    expect(digest.hottestProject).toBe('beta');
    expect(digest.perProject[0].project).toBe('beta');
    expect(digest.perProject[1].sessionCount).toBe(2);
    expect(digest.tokensIn).toBe(1150);
  });

  test('unknown-model sessions do not fabricate cost; known ones still sum', () => {
    const digest = aggregateDigest([
      session({ cwd: '/w/a', model: 'unknown-x', totalTokensIn: 1_000_000 }),
      session({ cwd: '/w/b', model: 'claude-haiku-4-5', totalTokensIn: 1_000_000 }),
    ]);
    const unknown = digest.perProject.find((p) => p.project === 'a');
    expect(unknown?.estimatedUsd).toBeNull();
    expect(digest.estimatedUsd).toBe(1); // haiku $1/MTok in
  });

  test('all-unknown models yield null total', () => {
    const digest = aggregateDigest([session({ model: 'x' })]);
    expect(digest.estimatedUsd).toBeNull();
  });

  test('active time merges close events, skips long gaps', () => {
    const ev = (atMs: number) => ({
      sessionId: 's', agentId: null, ts: new Date(atMs).toISOString(),
      seq: ++uid, uuid: `u${uid}`, kind: 'user-message' as const,
    });
    const digest = aggregateDigest([
      session({ events: [ev(T0), ev(T0 + 10_000), ev(T0 + 20_000), ev(T0 + 900_000)] }),
    ]);
    // two 10s gaps counted; the 880s gap skipped
    expect(digest.perProject[0].activeMs).toBe(20_000);
  });
});
