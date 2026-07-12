// Attention ribbon: one thin row above the axis showing where the user's
// prompts landed across sessions — each diamond is a prompt, colored by lane,
// so clusters and back-and-forth switching become visible at a glance.

import { memo } from 'react';
import type { AttentionSummary } from '../timeline-layout-engine';
import { laneColor } from '../lane-color-palette';

export const RIBBON_H = 14;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export const TimelineAttentionRibbon = memo(function TimelineAttentionRibbon({
  attention,
  laneIndexBySession,
  laneLabelBySession,
  msToX,
  viewWidth,
}: {
  attention: AttentionSummary;
  laneIndexBySession: Map<string, number>;
  laneLabelBySession: Map<string, string>;
  msToX: (ms: number) => number;
  viewWidth: number;
}) {
  return (
    <svg
      className="timeline-ribbon"
      viewBox={`0 0 ${viewWidth} ${RIBBON_H}`}
      preserveAspectRatio="none"
      style={{ height: RIBBON_H }}
    >
      <line x1={0} y1={RIBBON_H / 2} x2={viewWidth} y2={RIBBON_H / 2} className="ribbon-baseline" />
      {attention.points.map((point, i) => {
        const x = msToX(point.ms);
        if (x < 0 || x > viewWidth) return null;
        const laneIdx = laneIndexBySession.get(point.sessionId);
        const color = laneIdx === undefined ? '#5a6472' : laneColor(laneIdx);
        const y = RIBBON_H / 2;
        return (
          <g key={i} className="ribbon-point">
            <rect x={x - 3} y={y - 3} width={6} height={6} fill={color} transform={`rotate(45 ${x} ${y})`} />
            <title>{`${laneLabelBySession.get(point.sessionId) ?? point.sessionId} · ${fmtTime(point.ms)}`}</title>
          </g>
        );
      })}
    </svg>
  );
});
