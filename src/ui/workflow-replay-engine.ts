// Pure replay resolver for the workflow map: given a session's WorkflowTimeline
// and a chosen task (one per user prompt), turn the phases/spawns that fall in
// that task's [startTs, endTs] window into an ordered list of reveal steps, and
// resolve a playhead offset into "what has been revealed so far".
//
// No Date.now() inside — the playhead is an input — so the engine stays
// deterministic and fixture-testable like the other engines here.

import type { WorkflowTimeline } from '../shared/normalized-event-types';
import { phaseOf, type PhaseKey } from './workflow-graph-engine';

export interface ReplayStep {
  /** ms from the task start */
  offsetMs: number;
  kind: 'phase' | 'spawn';
  phaseKey: PhaseKey;
  /** present when kind === 'spawn' */
  agentType?: string;
}

export interface ReplaySteps {
  steps: ReplayStep[];
  /** length of the task window (>= 1) */
  durationMs: number;
  /** phase already active when the task began (carry-in), if any */
  carryInPhase: PhaseKey | null;
}

export interface ReplayState {
  /** phase active at the playhead (carry-in until the first reveal, then latest) */
  activePhase: PhaseKey | null;
  /** every phase revealed up to the playhead (includes carry-in) */
  revealedPhaseKeys: Set<PhaseKey>;
  /** subagents revealed up to the playhead */
  revealedSpawns: { phaseKey: PhaseKey; agentType: string }[];
}

function parse(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * Build the ordered reveal steps for task `taskIndex`. Phases and spawns whose
 * ts lies within the task window become steps; the phase active at the window
 * start (last phase at-or-before startMs) is the carry-in. Spawns are tied to
 * the phase active at their own ts.
 */
export function buildReplaySteps(
  timeline: WorkflowTimeline | undefined,
  taskIndex: number,
): ReplaySteps {
  const empty: ReplaySteps = { steps: [], durationMs: 1, carryInPhase: null };
  const task = timeline?.tasks?.[taskIndex];
  if (!timeline || !task) return empty;

  const startMs = parse(task.startTs);
  const endMs = parse(task.endTs);
  if (Number.isNaN(startMs)) return empty;
  // a valid window is [startMs, endMs]; guard against reversed/equal bounds
  const windowEnd = Number.isNaN(endMs) || endMs < startMs ? startMs : endMs;
  const durationMs = Math.max(1, windowEnd - startMs);

  // carry-in: the last phase that started at-or-before the window start
  let carryInPhase: PhaseKey | null = null;
  for (const p of timeline.phases) {
    const ms = parse(p.ts);
    if (!Number.isNaN(ms) && ms <= startMs) carryInPhase = phaseOf(p.skill);
    else if (!Number.isNaN(ms) && ms > startMs) break;
  }

  const steps: ReplayStep[] = [];
  for (const p of timeline.phases) {
    const ms = parse(p.ts);
    if (Number.isNaN(ms) || ms <= startMs || ms > windowEnd) continue;
    steps.push({ offsetMs: ms - startMs, kind: 'phase', phaseKey: phaseOf(p.skill) });
  }
  for (const s of timeline.spawns) {
    const ms = parse(s.ts);
    if (Number.isNaN(ms) || ms < startMs || ms > windowEnd) continue;
    steps.push({
      offsetMs: Math.max(0, ms - startMs),
      kind: 'spawn',
      phaseKey: phaseActiveAt(timeline, ms),
      agentType: s.agentType || 'agent',
    });
  }
  // deterministic order: by time, phases before spawns at the same instant
  steps.sort((a, b) => a.offsetMs - b.offsetMs || (a.kind === b.kind ? 0 : a.kind === 'phase' ? -1 : 1));
  return { steps, durationMs, carryInPhase };
}

/** Fold the reveal steps up to `playheadMs` into a render state. */
export function replayStateAt(replay: ReplaySteps, playheadMs: number): ReplayState {
  const revealedPhaseKeys = new Set<PhaseKey>();
  const revealedSpawns: { phaseKey: PhaseKey; agentType: string }[] = [];
  let activePhase = replay.carryInPhase;
  if (activePhase) revealedPhaseKeys.add(activePhase);

  for (const step of replay.steps) {
    if (step.offsetMs > playheadMs) break; // steps are sorted by time
    if (step.kind === 'phase') {
      activePhase = step.phaseKey;
      revealedPhaseKeys.add(step.phaseKey);
    } else {
      revealedSpawns.push({ phaseKey: step.phaseKey, agentType: step.agentType ?? 'agent' });
    }
  }
  return { activePhase, revealedPhaseKeys, revealedSpawns };
}

/** The phase whose start is the latest at-or-before `ms` (best-effort tie). */
function phaseActiveAt(timeline: WorkflowTimeline, ms: number): PhaseKey {
  let active: PhaseKey | null = null;
  for (const p of timeline.phases) {
    const pms = parse(p.ts);
    if (!Number.isNaN(pms) && pms <= ms) active = phaseOf(p.skill);
    else if (!Number.isNaN(pms) && pms > ms) break;
  }
  // a spawn before any recorded phase falls to the earliest known phase
  return active ?? (timeline.phases[0] ? phaseOf(timeline.phases[0].skill) : 'other');
}
