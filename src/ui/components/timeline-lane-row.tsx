// One session's swimlane: activity blocks on the main track, subagent branch
// spans as thin sub-rows beneath, all in SVG coordinates provided by the
// parent (which owns the ms->px mapping).

import { memo } from 'react';
import type { ActivityBlock, TimelineLane } from '../timeline-layout-engine';
import { CATEGORY_COLORS } from '../tool-category-mapping';

export const LANE_HEIGHT = 46;
const TRACK_H = 14;
const BRANCH_H = 5;
const BRANCH_GAP = 2;

const MARKER_COLORS: Record<string, string> = {
  prompt: '#3ddc84',
  error: '#e05555',
  question: '#f5a623',
};

export interface BlockPointerHandlers {
  onBlockHover: (lane: TimelineLane, block: ActivityBlock, clientX: number, clientY: number) => void;
  onBlockLeave: () => void;
  onBlockClick: (lane: TimelineLane, block: ActivityBlock, clientX: number, clientY: number) => void;
}

export const TimelineLaneRow = memo(function TimelineLaneRow({
  lane,
  laneIndex,
  msToX,
  windowEndX,
  onSelect,
  pointerHandlers,
}: {
  lane: TimelineLane;
  laneIndex: number;
  msToX: (ms: number) => number;
  /** x of the window's right edge, for open branch spans */
  windowEndX: number;
  onSelect: (sessionId: string) => void;
  pointerHandlers?: BlockPointerHandlers;
}) {
  const top = laneIndex * LANE_HEIGHT;
  const trackY = top + 10;

  return (
    <g className="timeline-lane" onClick={() => onSelect(lane.sessionId)}>
      {/* faint full-width track line for orientation */}
      <line x1={0} y1={trackY + TRACK_H / 2} x2={windowEndX} y2={trackY + TRACK_H / 2} className="lane-track-line" />
      {lane.waitingStretches.map((stretch, i) => {
        const x = msToX(stretch.startMs);
        const width = Math.max(msToX(stretch.endMs) - x, 2);
        return (
          <rect
            key={`w${i}`}
            x={x}
            y={trackY}
            width={width}
            height={TRACK_H}
            fill="url(#wait-hatch)"
            className={stretch.inferred ? 'waiting-stretch inferred' : 'waiting-stretch'}
          >
            <title>
              {stretch.inferred ? 'chờ bạn (suy luận từ khoảng lặng)' : 'đang chờ bạn'}
            </title>
          </rect>
        );
      })}
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
            onMouseEnter={(e) => pointerHandlers?.onBlockHover(lane, block, e.clientX, e.clientY)}
            onMouseLeave={() => pointerHandlers?.onBlockLeave()}
            onClick={(e) => {
              e.stopPropagation();
              pointerHandlers?.onBlockClick(lane, block, e.clientX, e.clientY);
            }}
          />
        );
      })}
      {lane.markers.map((marker, i) => {
        const x = msToX(marker.ms);
        const y = trackY - 4;
        const color = MARKER_COLORS[marker.kind];
        return (
          <g key={`m${i}`} className="lane-marker">
            {marker.kind === 'prompt' ? (
              <rect x={x - 3} y={y - 3} width={6} height={6} fill={color} transform={`rotate(45 ${x} ${y})`} />
            ) : marker.kind === 'question' ? (
              <circle cx={x} cy={y} r={3.4} fill={color} />
            ) : (
              <rect x={x - 1} y={y - 4} width={2} height={8} fill={color} />
            )}
            {marker.label ? <title>{marker.label}</title> : <title>{marker.kind === 'error' ? 'tool lỗi' : marker.kind}</title>}
          </g>
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
