// Digest strip + expandable per-project panel. All figures are scoped to the
// observed window (24h discovery, tail replay) and costs are estimates —
// labeled as such, per design.

import { memo, useMemo, useState } from 'react';
import type { SessionSnapshot } from '../../shared/normalized-event-types';
import { aggregateDigest } from '../digest-aggregation';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtUsd(n: number | null): string {
  return n === null ? '—' : `~$${n.toFixed(2)}`;
}

function fmtActive(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}`;
}

export const DailyDigestStrip = memo(function DailyDigestStrip({
  sessions,
}: {
  sessions: SessionSnapshot[];
}) {
  const [open, setOpen] = useState(false);
  const digest = useMemo(() => aggregateDigest(sessions), [sessions]);
  if (digest.sessionCount === 0) return null;

  return (
    <div className="digest">
      <button
        className="digest-strip"
        onClick={() => setOpen((o) => !o)}
        title="24h gần nhất (cửa sổ quan sát) · chi phí là ước tính theo bảng giá công khai — chưa gồm cache-write premium; token sub-agent tính theo giá model chính của session"
      >
        24h: {digest.sessionCount} sessions · ▲{fmtTokens(digest.tokensIn)} ▼
        {fmtTokens(digest.tokensOut)} ({fmtUsd(digest.estimatedUsd)})
        {digest.hottestProject ? ` · nóng nhất: ${digest.hottestProject}` : ''} {open ? '▴' : '▾'}
      </button>
      {open ? (
        <table className="digest-table">
          <thead>
            <tr>
              <th>project</th>
              <th>sessions</th>
              <th>▲in</th>
              <th>▼out</th>
              <th>cache</th>
              <th>~$ (ước tính)</th>
              <th>active</th>
            </tr>
          </thead>
          <tbody>
            {digest.perProject.map((p) => (
              <tr key={p.project}>
                <td>{p.project}</td>
                <td>{p.sessionCount}</td>
                <td>{fmtTokens(p.tokensIn)}</td>
                <td>{fmtTokens(p.tokensOut)}</td>
                <td>{fmtTokens(p.cacheRead)}</td>
                <td>{fmtUsd(p.estimatedUsd)}</td>
                <td>{fmtActive(p.activeMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
});
