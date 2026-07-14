// The card's MK workflow map: the phases a session moved through (brainstorm →
// plan → cook → review → journal), how many times it re-entered each, and the
// subagents each phase spawned. Laid out as a vertical list so it stays legible
// in the card's narrow column — the loop count in the header captures rhythm.
// Collapsed to a one-line summary badge by default (the card is already tall).

import { memo, useMemo, useState } from 'react';
import type { SessionSnapshot } from '../../shared/normalized-event-types';
import { buildWorkflowGraph } from '../workflow-graph-engine';
import { PHASE_COLOR } from '../phase-color-palette';

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

export const SessionWorkflowMap = memo(function SessionWorkflowMap({
  session,
}: {
  session: SessionSnapshot;
}) {
  const graph = useMemo(() => buildWorkflowGraph(session.workflow), [session.workflow]);
  const openKey = `kansh-workflow-open:${session.sessionId}`;
  // open by default; only a stored '0' (user collapsed it) keeps it closed
  const [open, setOpen] = useState(() => localStorage.getItem(openKey) !== '0');

  // non-MK / empty session → render nothing so plain sessions stay clean
  if (graph.phaseCount === 0) return null;

  const toggle = () => {
    setOpen((o) => {
      localStorage.setItem(openKey, o ? '0' : '1');
      return !o;
    });
  };

  return (
    <div className="workflow-map">
      <button className="workflow-toggle" onClick={toggle}>
        {open ? '▴' : '▾'} ⚙ {graph.phaseCount} phases · {graph.agentCount} agents
        {graph.loopCount > 0 ? ` · ↻ ${graph.loopCount} loops` : ''}
      </button>
      {open ? (
        <ul className="workflow-phase-list">
          {graph.nodes.map((node) => {
            const detail =
              `${node.visits} lần vào` +
              (node.lastMs > node.firstMs ? ` · ${fmtDuration(node.firstMs, node.lastMs)}` : '') +
              (node.tokensIn + node.tokensOut > 0
                ? ` · ▲${fmtTokens(node.tokensIn)} ▼${fmtTokens(node.tokensOut)}`
                : '');
            return (
              <li key={node.key} className={node.active ? 'workflow-phase active' : 'workflow-phase'}>
                <div className="workflow-phase-head">
                  <span
                    className="workflow-phase-pill"
                    style={{ background: PHASE_COLOR[node.key] }}
                    title={detail}
                  >
                    {node.label}
                    {node.visits > 1 ? ` ×${node.visits}` : ''}
                  </span>
                  {node.active ? <span className="workflow-phase-now">● đang chạy</span> : null}
                  {node.subagents.length === 0 && node.hiddenSubagentTypes === 0 ? (
                    <span className="workflow-phase-detail">{detail}</span>
                  ) : null}
                </div>
                {node.subagents.length > 0 || node.hiddenSubagentTypes > 0 ? (
                  <div className="workflow-phase-agents">
                    {node.subagents.map((sa) => (
                      <span className="workflow-agent-chip" key={sa.agentType} title={`${sa.agentType} ×${sa.count}`}>
                        ⤷ {sa.agentType} <b>×{sa.count}</b>
                      </span>
                    ))}
                    {node.hiddenSubagentTypes > 0 ? (
                      <span className="workflow-agent-chip more">+{node.hiddenSubagentTypes} loại</span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
          <li className="workflow-hint">ước lượng: subagent gắn với pha theo thời điểm spawn</li>
        </ul>
      ) : null}
    </div>
  );
});
