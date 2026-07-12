// SVG renderer for one session's git-graph. Pure function of (events, status);
// memoized so unrelated store updates don't re-render every card.

import { memo, useMemo } from 'react';
import type { NormalizedEvent, SessionStatus } from '../../shared/normalized-event-types';
import { layoutSessionGraph, type GraphNode } from '../graph-layout-engine';
import { eventColor, eventLabel } from './tool-node-glyph';

function formatIdle(durationMs: number): string {
  const minutes = Math.round(durationMs / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

const ROW_H = 26;
const COL_W = 22;
const PAD_X = 14;
const PAD_Y = 14;
const NODE_R = 4.5;
const LABEL_X_GAP = 12;

function nodeXY(node: Pick<GraphNode, 'row' | 'column'>): [number, number] {
  return [PAD_X + node.column * COL_W, PAD_Y + node.row * ROW_H];
}

interface GitGraphSvgProps {
  events: NormalizedEvent[];
  status: SessionStatus;
  onSelectEvent?: (event: NormalizedEvent) => void;
  /** condensed-segment uuids currently expanded (owned by the card) */
  expandedSegments?: Set<string>;
  onToggleSegment?: (segmentUuid: string) => void;
  /** tool-start uuids still awaiting their tool-end (live elapsed shown) */
  pendingToolUuids?: Set<string>;
  /** changes each second while tools are pending — busts memo so ⏱ ticks */
  renderTick?: number;
}

export const GitGraphSvg = memo(function GitGraphSvg({
  events,
  status,
  onSelectEvent,
  expandedSegments,
  onToggleSegment,
  pendingToolUuids,
}: GitGraphSvgProps) {
  const layout = useMemo(
    () => layoutSessionGraph(events, { expanded: expandedSegments }),
    [events, expandedSegments],
  );
  // edges reference both real nodes and condensed pseudo-nodes
  const byUuid = useMemo(() => {
    const map = new Map<string, { row: number; column: number }>(
      layout.nodes.map((n) => [n.uuid, n]),
    );
    for (const seg of layout.condensed) map.set(seg.uuid, seg);
    return map;
  }, [layout]);

  const height = PAD_Y * 2 + Math.max(layout.rowCount, 1) * ROW_H;
  // each label sits immediately right of its own node — one node per row, so
  // nothing overlaps and the eye never travels across open branch columns
  const labelXFor = (column: number) => PAD_X + column * COL_W + LABEL_X_GAP;
  const maxNodeX = PAD_X + (layout.columnCount - 1) * COL_W;
  const maxLabelX = maxNodeX + LABEL_X_GAP;
  const width = maxLabelX + 260;

  const lastNode = layout.nodes[layout.nodes.length - 1];
  const isLive = status === 'running';
  // live indicators: newest node + every still-open subagent branch tip
  const pulseUuids = useMemo(() => {
    if (!isLive) return new Set<string>();
    const set = new Set(layout.openBranchTips);
    if (lastNode) set.add(lastNode.uuid);
    return set;
  }, [isLive, layout, lastNode]);

  // tool durations: tool-end hover shows elapsed since its tool-start
  const toolStartTsByUseId = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) if (e.kind === 'tool-start' && e.toolUseId) map.set(e.toolUseId, e.ts);
    return map;
  }, [events]);
  const formatElapsed = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <svg width={width} height={height} className="graph-svg" role="img" aria-label="session activity graph">
      {layout.edges.map((edge, i) => {
        const from = byUuid.get(edge.fromUuid);
        const to = byUuid.get(edge.toUuid);
        if (!from || !to) return null;
        const [x1, y1] = nodeXY(from);
        const [x2, y2] = nodeXY(to);
        const isBranch = edge.kind !== 'lane';
        // branch curves bow horizontally; lane edges are straight verticals
        const d = isBranch
          ? `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`
          : `M ${x1} ${y1} L ${x2} ${y2}`;
        return (
          <path
            key={i}
            d={d}
            className={edge.kind === 'lane' ? 'edge-lane' : 'edge-branch'}
            fill="none"
          />
        );
      })}
      {layout.gaps.map((gap) => {
        const y = PAD_Y + gap.row * ROW_H;
        return (
          <g key={gap.uuid} className="gap-marker">
            <line x1={PAD_X - 8} y1={y} x2={maxLabelX + 200} y2={y} className="gap-line" />
            <text x={maxLabelX} y={y - 4} className="gap-label">
              ⏱ idle {formatIdle(gap.durationMs)}
            </text>
          </g>
        );
      })}
      {layout.condensed.map((seg) => {
        const [x, y] = nodeXY(seg);
        return (
          <g
            key={seg.uuid}
            className="graph-node condensed-segment"
            onClick={() => onToggleSegment?.(seg.uuid)}
          >
            <rect x={PAD_X - 10} y={y - ROW_H / 2} width={maxLabelX + 250} height={ROW_H} fill="transparent" />
            {[-5, 0, 5].map((dy) => (
              <circle key={dy} cx={x} cy={y + dy} r={1.4} fill="#5a6478" />
            ))}
            <text x={labelXFor(seg.column)} y={y + 3.5} className="condensed-label">
              ⋮ {seg.count} steps
            </text>
          </g>
        );
      })}
      {layout.nodes.map((node) => {
        const [x, y] = nodeXY(node);
        const color = eventColor(node.event);
        const label = eventLabel(node.event);
        const pulse = pulseUuids.has(node.uuid);
        // label-less plumbing (tool-end, empty assistant turns) stays visible
        // as small dim dots so lanes read continuously without noise
        const minor = !label && !pulse;
        const labelX = labelXFor(node.column);
        const isPendingTool = pendingToolUuids?.has(node.uuid) ?? false;
        const pendingElapsed = isPendingTool ? formatElapsed(Date.now() - Date.parse(node.event.ts)) : null;
        const doneDuration =
          node.event.kind === 'tool-end' && node.event.toolUseId
            ? toolStartTsByUseId.get(node.event.toolUseId)
            : undefined;
        const hoverTitle = doneDuration
          ? `took ${formatElapsed(Date.parse(node.event.ts) - Date.parse(doneDuration))}`
          : undefined;
        return (
          <g key={node.uuid} className="graph-node" onClick={() => onSelectEvent?.(node.event)}>
            {hoverTitle ? <title>{hoverTitle}</title> : null}
            {pulse ? <circle cx={x} cy={y} r={NODE_R + 3} fill={color} className="node-pulse" /> : null}
            {/* invisible wide hit target so small dots stay clickable */}
            <rect x={PAD_X - 10} y={y - ROW_H / 2} width={maxLabelX + 250} height={ROW_H} fill="transparent" />
            <circle cx={x} cy={y} r={minor ? 2 : NODE_R} fill={color} opacity={minor ? 0.35 : 1} />
            {label ? (
              <text x={labelX} y={y + 3.5} className="node-label" fill={color}>
                {label.length > 46 ? label.slice(0, 46) + '…' : label}
                {pendingElapsed ? <tspan className="pending-elapsed"> ⏱ {pendingElapsed}…</tspan> : null}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
});
