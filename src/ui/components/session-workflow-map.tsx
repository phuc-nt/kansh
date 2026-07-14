// The card's MK workflow map: phase pills (brainstorm → plan → cook → review →
// journal) with edges thickened by how many times each transition happened
// (thick = many build loops), and each phase's spawned subagents as chips.
// Collapsed to a one-line summary badge by default (the card is already tall).

import { memo, useMemo, useState } from 'react';
import type { SessionSnapshot } from '../../shared/normalized-event-types';
import { buildWorkflowGraph, type PhaseKey, type WorkflowNode } from '../workflow-graph-engine';
import { PHASE_COLOR } from '../phase-color-palette';

const NODE_W = 62;
const NODE_H = 24;
const NODE_GAP = 30;
const ROW_Y = 40; // node row baseline; edges arc above, subagents list below
const PAD_X = 8;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtDuration(firstMs: number, lastMs: number): string {
  const min = Math.max(0, Math.round((lastMs - firstMs) / 60_000));
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

/** Keep subagent chips from bleeding past their node's slot. */
function shortAgent(agentType: string): string {
  return agentType.length > 13 ? agentType.slice(0, 12) + '…' : agentType;
}

interface Placed {
  node: WorkflowNode;
  x: number; // center x
  cy: number; // center y
}

export const SessionWorkflowMap = memo(function SessionWorkflowMap({
  session,
}: {
  session: SessionSnapshot;
}) {
  const graph = useMemo(() => buildWorkflowGraph(session.workflow), [session.workflow]);
  const openKey = `kansh-workflow-open:${session.sessionId}`;
  const [open, setOpen] = useState(() => localStorage.getItem(openKey) === '1');

  // non-MK / empty session → render nothing so plain sessions stay clean
  if (graph.phaseCount === 0) return null;

  const toggle = () => {
    setOpen((o) => {
      localStorage.setItem(openKey, o ? '0' : '1');
      return !o;
    });
  };

  // nodes laid left→right in engine (stable) order
  const placed: Placed[] = graph.nodes.map((node, i) => ({
    node,
    x: PAD_X + NODE_W / 2 + i * (NODE_W + NODE_GAP),
    cy: ROW_Y,
  }));
  const xByKey = new Map<PhaseKey, number>(placed.map((p) => [p.node.key, p.x]));
  // extra right pad: the last node's centered subagent chips extend past NODE_W
  const svgW = PAD_X * 2 + 40 + placed.length * NODE_W + (placed.length - 1) * NODE_GAP;
  // tallest subagent stack decides height
  const maxSubRows = Math.max(0, ...graph.nodes.map((n) => n.subagents.length + (n.hiddenSubagentTypes ? 1 : 0)));
  const svgH = ROW_Y + NODE_H / 2 + 10 + maxSubRows * 14 + 6;

  const maxWeight = Math.max(1, ...graph.edges.map((e) => e.weight));

  return (
    <div className="workflow-map">
      <button className="workflow-toggle" onClick={toggle}>
        {open ? '▴' : '▾'} ⚙ {graph.phaseCount} phases · {graph.agentCount} agents
        {graph.loopCount > 0 ? ` · ↻ ${graph.loopCount} loops` : ''}
      </button>
      {open ? (
        <div className="workflow-svg-wrap">
          <svg
            className="workflow-svg"
            viewBox={`0 0 ${svgW} ${svgH}`}
            width={svgW}
            height={svgH}
            preserveAspectRatio="xMinYMin meet"
            role="img"
          >
            <defs>
              <marker id="wf-arrow" viewBox="0 0 8 8" refX={6} refY={4} markerWidth={6} markerHeight={6} orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#6b7685" />
              </marker>
            </defs>
            {/* edges: arc above the row, thicker = more repeats of that transition */}
            {graph.edges.map((edge, i) => {
              const x1 = xByKey.get(edge.from);
              const x2 = xByKey.get(edge.to);
              if (x1 === undefined || x2 === undefined) return null;
              const dir = x2 >= x1 ? 1 : -1;
              const from = x1 + dir * (NODE_W / 2 - 2);
              const to = x2 - dir * (NODE_W / 2);
              const midY = ROW_Y - 18 - Math.min(14, Math.abs(x2 - x1) / 12);
              const width = 1 + (edge.weight / maxWeight) * 3.5;
              return (
                <g key={`e${i}`} className="workflow-edge">
                  <path
                    d={`M${from},${ROW_Y - NODE_H / 2 + 4} Q${(from + to) / 2},${midY} ${to},${ROW_Y - NODE_H / 2 + 4}`}
                    fill="none"
                    stroke="#6b7685"
                    strokeWidth={width}
                    markerEnd="url(#wf-arrow)"
                    opacity={0.75}
                  />
                  {edge.weight > 1 ? (
                    <text x={(from + to) / 2} y={midY - 2} className="workflow-edge-label" textAnchor="middle">
                      ×{edge.weight}
                    </text>
                  ) : null}
                  <title>{`${edge.from} → ${edge.to} ×${edge.weight}`}</title>
                </g>
              );
            })}
            {/* phase nodes */}
            {placed.map(({ node, x, cy }) => (
              <g key={node.key} className={node.active ? 'workflow-node active' : 'workflow-node'}>
                <rect
                  x={x - NODE_W / 2}
                  y={cy - NODE_H / 2}
                  width={NODE_W}
                  height={NODE_H}
                  rx={NODE_H / 2}
                  fill={PHASE_COLOR[node.key]}
                  opacity={node.active ? 1 : 0.82}
                />
                <text x={x} y={cy + 4} className="workflow-node-label" textAnchor="middle">
                  {node.label}
                  {node.visits > 1 ? ` ×${node.visits}` : ''}
                </text>
                <title>
                  {`${node.label}: ${node.visits} lần vào` +
                    (node.lastMs > node.firstMs ? ` · ${fmtDuration(node.firstMs, node.lastMs)}` : '') +
                    (node.tokensIn + node.tokensOut > 0
                      ? ` · ▲${fmtTokens(node.tokensIn)} ▼${fmtTokens(node.tokensOut)}`
                      : '')}
                </title>
                {/* subagent chips beneath the node */}
                {node.subagents.map((sa, j) => (
                  <text
                    key={sa.agentType}
                    x={x}
                    y={cy + NODE_H / 2 + 12 + j * 14}
                    className="workflow-subagent-chip"
                    textAnchor="middle"
                  >
                    {/* title first: SVG only renders it as a tooltip as the first child */}
                    <title>{`${sa.agentType} ×${sa.count}`}</title>
                    ⤷ {shortAgent(sa.agentType)} ×{sa.count}
                  </text>
                ))}
                {node.hiddenSubagentTypes > 0 ? (
                  <text
                    x={x}
                    y={cy + NODE_H / 2 + 12 + node.subagents.length * 14}
                    className="workflow-subagent-chip more"
                    textAnchor="middle"
                  >
                    +{node.hiddenSubagentTypes} loại
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
          <div className="workflow-hint">ước lượng: subagent gắn với pha theo thời điểm spawn</div>
        </div>
      ) : null}
    </div>
  );
});
