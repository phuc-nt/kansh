// Mini events-per-minute sparkline for a session card header.
// Pure client-side: derived from the events the card already holds. The
// client event cap (600) may cover less than the full hour on busy sessions —
// the tooltip states the actual covered window.

import { memo, useMemo } from 'react';
import type { NormalizedEvent } from '../../shared/normalized-event-types';

const WIDTH = 96;
const HEIGHT = 16;
const BUCKET_MS = 2 * 60 * 1000; // 30 buckets × 2min = 60 minutes
const BUCKETS = 30;

export const ActivitySparkline = memo(function ActivitySparkline({
  events,
}: {
  events: NormalizedEvent[];
}) {
  const { path, peak, coveredMinutes } = useMemo(() => {
    const now = Date.now();
    const counts = new Array<number>(BUCKETS).fill(0);
    let oldestMs = now;
    for (const event of events) {
      const ts = Date.parse(event.ts);
      if (Number.isNaN(ts)) continue;
      if (ts < oldestMs) oldestMs = ts;
      const age = now - ts;
      if (age < 0 || age >= BUCKETS * BUCKET_MS) continue;
      counts[BUCKETS - 1 - Math.floor(age / BUCKET_MS)]++;
    }
    const peak = Math.max(...counts, 1);
    const step = WIDTH / (BUCKETS - 1);
    const points = counts.map(
      (c, i) => `${(i * step).toFixed(1)},${(HEIGHT - 2 - (c / peak) * (HEIGHT - 4)).toFixed(1)}`,
    );
    return {
      path: `M ${points.join(' L ')}`,
      peak,
      coveredMinutes: Math.min(60, Math.round((now - oldestMs) / 60000)),
    };
  }, [events]);

  if (events.length === 0) return null;
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      className="activity-sparkline"
      aria-label="activity over the last hour"
    >
      <title>{`hoạt động ${coveredMinutes} phút gần nhất · đỉnh ${peak} events/2m`}</title>
      <path d={path} fill="none" className="sparkline-path" />
    </svg>
  );
});
