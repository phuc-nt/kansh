// The card's MK workflow map: the phases a session moved through (brainstorm →
// plan → cook → review → journal), how many times it re-entered each, and the
// subagents each phase spawned. Laid out as a vertical list so it stays legible
// in the card's narrow column — the loop count in the header captures rhythm.
//
// Replay mode (v0.8): pick a task (one per user prompt) and watch its workflow
// reveal over time — phases dim until reached, the current phase pulses, and
// subagent chips fade in when spawned. The playhead advances on an INTERVAL
// (not rAF) so it keeps moving in a backgrounded tab — the monitor's default.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSnapshot } from '../../shared/normalized-event-types';
import { buildWorkflowGraph, type PhaseKey } from '../workflow-graph-engine';
import { PHASE_COLOR } from '../phase-color-palette';
import { buildReplaySteps, replayStateAt } from '../workflow-replay-engine';
import { REPLAY_SPEEDS, SessionWorkflowReplayControls } from './session-workflow-replay-controls';

/** interval tick period — coarse enough to be cheap, fine enough to feel smooth */
const TICK_MS = 80;

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

  // --- replay state ---
  const tasks = session.workflow?.tasks ?? [];
  const [replaying, setReplaying] = useState(false);
  const [taskIndex, setTaskIndex] = useState(() => Math.max(0, tasks.length - 1));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [playheadMs, setPlayheadMs] = useState(0);

  const replay = useMemo(
    () => buildReplaySteps(session.workflow, taskIndex),
    [session.workflow, taskIndex],
  );

  // interval playhead: keeps advancing even when the tab is backgrounded (rAF
  // does not fire there). Stops at the task end.
  const lastTickRef = useRef(0);
  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = 0; // reset delta baseline on (re)start
    const timer = setInterval(() => {
      setPlayheadMs((prev) => {
        // advance by wall time × speed; use TICK_MS as the delta (interval is
        // approximately periodic — good enough for a replay scrubber)
        const next = prev + TICK_MS * speed;
        if (next >= replay.durationMs) {
          setPlaying(false);
          return replay.durationMs;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, replay.durationMs]);

  const state = useMemo(() => replayStateAt(replay, playheadMs), [replay, playheadMs]);

  if (graph.phaseCount === 0) return null;

  const toggle = () => {
    setOpen((o) => {
      localStorage.setItem(openKey, o ? '0' : '1');
      return !o;
    });
  };

  const pickTask = (i: number) => {
    setTaskIndex(Math.max(0, Math.min(tasks.length - 1, i)));
    setPlayheadMs(0);
    setPlaying(false);
  };
  const enterReplay = () => {
    // start on the most recent task that actually has phase/spawn activity —
    // the very last task is often the still-open current one (empty window)
    let start = Math.max(0, tasks.length - 1);
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (buildReplaySteps(session.workflow, i).steps.length > 0) {
        start = i;
        break;
      }
    }
    setReplaying(true);
    setTaskIndex(start);
    setPlayheadMs(0);
    setPlaying(true);
  };
  const exitReplay = () => {
    setReplaying(false);
    setPlaying(false);
  };
  const cycleSpeed = () => {
    const i = REPLAY_SPEEDS.indexOf(speed as (typeof REPLAY_SPEEDS)[number]);
    setSpeed(REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length]);
  };
  const scrub = (ms: number) => {
    setPlaying(false);
    setPlayheadMs(ms);
  };

  // in replay mode a phase pill is only "revealed" once the playhead reaches it
  const isRevealed = (key: PhaseKey) => !replaying || state.revealedPhaseKeys.has(key);
  const isActive = (key: PhaseKey, staticActive: boolean) =>
    replaying ? state.activePhase === key : staticActive;
  // subagents shown in replay = only those revealed so far, by phase
  const revealedByPhase = useMemo(() => {
    const m = new Map<PhaseKey, Set<string>>();
    for (const s of state.revealedSpawns) {
      let set = m.get(s.phaseKey);
      if (!set) m.set(s.phaseKey, (set = new Set()));
      set.add(s.agentType);
    }
    return m;
  }, [state.revealedSpawns]);

  return (
    <div className="workflow-map">
      <div className="workflow-header">
        <button className="workflow-toggle" onClick={toggle}>
          {open ? '▴' : '▾'} ⚙ {graph.phaseCount} phases · {graph.agentCount} agents
          {graph.loopCount > 0 ? ` · ↻ ${graph.loopCount} loops` : ''}
        </button>
        {open && tasks.length > 0 && !replaying ? (
          <button className="workflow-replay-enter" onClick={enterReplay} title="xem lại workflow theo từng task">
            ⏵ replay
          </button>
        ) : null}
      </div>

      {open && replaying ? (
        <SessionWorkflowReplayControls
          tasks={tasks}
          taskIndex={taskIndex}
          playing={playing}
          speed={speed}
          playheadMs={playheadMs}
          durationMs={replay.durationMs}
          onPickTask={pickTask}
          onTogglePlay={() => setPlaying((p) => !p)}
          onCycleSpeed={cycleSpeed}
          onScrub={scrub}
          onExit={exitReplay}
        />
      ) : null}

      {open ? (
        <ul className={replaying ? 'workflow-phase-list replaying' : 'workflow-phase-list'}>
          {graph.nodes.map((node) => {
            const detail =
              `${node.visits} lần vào` +
              (node.lastMs > node.firstMs ? ` · ${fmtDuration(node.firstMs, node.lastMs)}` : '') +
              (node.tokensIn + node.tokensOut > 0
                ? ` · ▲${fmtTokens(node.tokensIn)} ▼${fmtTokens(node.tokensOut)}`
                : '');
            const revealed = isRevealed(node.key);
            const active = isActive(node.key, node.active);
            const shownAgents = replaying
              ? node.subagents.filter((sa) => revealedByPhase.get(node.key)?.has(sa.agentType))
              : node.subagents;
            const showHidden = !replaying && node.hiddenSubagentTypes > 0;
            return (
              <li
                key={node.key}
                className={
                  'workflow-phase' +
                  (active ? ' active' : '') +
                  (replaying && !revealed ? ' dim' : '')
                }
              >
                <div className="workflow-phase-head">
                  <span className="workflow-phase-pill" style={{ background: PHASE_COLOR[node.key] }} title={detail}>
                    {node.label}
                    {!replaying && node.visits > 1 ? ` ×${node.visits}` : ''}
                  </span>
                  {active ? <span className="workflow-phase-now">● đang chạy</span> : null}
                  {!replaying && node.subagents.length === 0 && node.hiddenSubagentTypes === 0 ? (
                    <span className="workflow-phase-detail">{detail}</span>
                  ) : null}
                </div>
                {shownAgents.length > 0 || showHidden ? (
                  <div className="workflow-phase-agents">
                    {shownAgents.map((sa) => (
                      <span className="workflow-agent-chip" key={sa.agentType} title={`${sa.agentType} ×${sa.count}`}>
                        ⤷ {sa.agentType}
                        {!replaying ? <b> ×{sa.count}</b> : null}
                      </span>
                    ))}
                    {showHidden ? (
                      <span className="workflow-agent-chip more">+{node.hiddenSubagentTypes} loại</span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
          {replaying && replay.steps.length === 0 ? (
            <li className="workflow-hint">task này không có chuyển pha — chỉ tiếp tục pha đang chạy</li>
          ) : (
            <li className="workflow-hint">ước lượng: subagent gắn với pha theo thời điểm spawn</li>
          )}
        </ul>
      ) : null}
    </div>
  );
});
