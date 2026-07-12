// Pure aggregation for the digest strip/panel: sessions -> totals and
// per-project rollups (tokens, estimated cost, active time). All numbers are
// scoped to the observed window (24h discovery + tail replay) — the UI labels
// them accordingly.

import type { SessionSnapshot } from '../shared/normalized-event-types';
import { estimateCostUsd } from '../shared/model-pricing';

/** consecutive events closer than this count as continuous active time */
const ACTIVE_MERGE_GAP_MS = 60_000;

export interface ProjectDigest {
  project: string;
  sessionCount: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  /** null when no session's model has known pricing */
  estimatedUsd: number | null;
  activeMs: number;
}

export interface DigestTotals {
  sessionCount: number;
  liveCount: number;
  tokensIn: number;
  tokensOut: number;
  estimatedUsd: number | null;
  hottestProject: string | null;
  perProject: ProjectDigest[];
}

function projectLabel(session: SessionSnapshot): string {
  if (session.cwd) return session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  return session.project;
}

// activeTimeMs is O(E log E) and the digest recomputes on every WS commit —
// cache per events-array identity so unchanged sessions cost a map lookup.
const activeTimeCache = new WeakMap<readonly unknown[], number>();

/** Sum of active stretches (same block-merge rule as the timeline). */
function activeTimeMs(session: SessionSnapshot): number {
  const cached = activeTimeCache.get(session.events);
  if (cached !== undefined) return cached;
  const times = session.events
    .map((e) => Date.parse(e.ts))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap < ACTIVE_MERGE_GAP_MS) total += gap;
  }
  activeTimeCache.set(session.events, total);
  return total;
}

export function aggregateDigest(sessions: SessionSnapshot[]): DigestTotals {
  const byProject = new Map<string, ProjectDigest>();

  for (const session of sessions) {
    const key = projectLabel(session);
    let entry = byProject.get(key);
    if (!entry) {
      byProject.set(
        key,
        (entry = {
          project: key,
          sessionCount: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          estimatedUsd: null,
          activeMs: 0,
        }),
      );
    }
    entry.sessionCount++;
    entry.tokensIn += session.totalTokensIn;
    entry.tokensOut += session.totalTokensOut;
    entry.cacheRead += session.totalTokensCacheRead;
    entry.activeMs += activeTimeMs(session);
    const cost = estimateCostUsd(session.model, {
      inTokens: session.totalTokensIn,
      outTokens: session.totalTokensOut,
      cacheReadTokens: session.totalTokensCacheRead,
    });
    if (cost !== null) entry.estimatedUsd = (entry.estimatedUsd ?? 0) + cost;
  }

  const perProject = [...byProject.values()].sort(
    (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
  );
  const totals: DigestTotals = {
    sessionCount: sessions.length,
    liveCount: sessions.filter((s) => s.status !== 'ended').length,
    tokensIn: perProject.reduce((n, p) => n + p.tokensIn, 0),
    tokensOut: perProject.reduce((n, p) => n + p.tokensOut, 0),
    estimatedUsd: perProject.some((p) => p.estimatedUsd !== null)
      ? perProject.reduce((n, p) => n + (p.estimatedUsd ?? 0), 0)
      : null,
    hottestProject: perProject[0]?.project ?? null,
    perProject,
  };
  return totals;
}
