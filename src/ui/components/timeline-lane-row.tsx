// One session's swimlane: activity blocks on the main track, subagent branch
// spans as thin sub-rows beneath, all in SVG coordinates provided by the
// parent (which owns the ms->px mapping).

import { memo } from 'react';
import type { TimelineLane } from '../timeline-layout-engine';
import { CATEGORY_COLORS } from '../tool-category-mapping';

export const LANE_HEIGHT = 46;
const TRACK_H = 14;
const BRANCH_H = 5;
const BRANCH_GAP = 2;

export const TimelineLaneRow = memo(function TimelineLaneRow({
  lane,
  laneIndex,
  msToX,
  windowEndX,
  onSelect,
}: {
  lane: TimelineLane;
  laneIndex: number;
  msToX: (ms: number) => number;
  /** x of the window's right edge, for open branch spans */
  windowEndX: number;
  onSelect: (sessionId: string) => void;
}) {
  const top = laneIndex * LANE_HEIGHT;
  const trackY = top + 10;

  return (
    <g className="timeline-lane" onClick={() => onSelect(lane.sessionId)}>
      {/* faint full-width track line for orientation */}
      <line x1={0} y1={trackY + TRACK_H / 2} x2={windowEndX} y2={trackY + TRACK_H / 2} className="lane-track-line" />
      {lane.blocks.map((block, i) => {
        const x = msToX(block.startMs);
        const width = Math.max(msToX(block.endMs) - x, 2);
        return (
          <rect
            key={i}
            x={x}
            y={trackY}
            width={width}
            height={TRACK_H}
            rx={3}
            fill={CATEGORY_COLORS[block.dominantCategory]}
            className="activity-block"
          >
            <title>{`${block.eventCount} events · ${block.dominantCategory}`}</title>
          </rect>
        );
      })}
      {lane.branches.map((branch, i) => {
        const x = msToX(branch.startMs);
        const endX = branch.endMs === null ? windowEndX : msToX(branch.endMs);
        // nested (depth>=2) spans indent one sub-row further
        const depthRow = Math.min(branch.depth, 2) - 1;
        const y = trackY + TRACK_H + 3 + depthRow * (BRANCH_H + BRANCH_GAP);
        return (
          <rect
            key={`b${i}`}
            x={x}
            y={y}
            width={Math.max(endX - x, 2)}
            height={BRANCH_H}
            rx={2}
            className={branch.endMs === null ? 'branch-span branch-open' : 'branch-span'}
          >
            <title>{`${branch.agentType ?? 'agent'}${branch.depth > 1 ? ` (depth ${branch.depth})` : ''}${branch.endMs === null ? ' · running' : ''}`}</title>
          </rect>
        );
      })}
      {lane.clippedLeft ? (
        <text x={2} y={trackY + TRACK_H - 3} className="clip-hint">
          ‹
        </text>
      ) : null}
      {lane.clippedRight ? (
        <text x={windowEndX - 8} y={trackY + TRACK_H - 3} className="clip-hint">
          ›
        </text>
      ) : null}
      {lane.droppedBlocks > 0 ? <title>{`${lane.droppedBlocks} older blocks not shown`}</title> : null}
    </g>
  );
});
