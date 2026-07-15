// Fixtures for the workflow replay engine: task-window filtering, carry-in
// phase, spawn tie, playhead folding, and degenerate cases.

import { describe, expect, test } from 'bun:test';
import type { WorkflowTimeline } from '../shared/normalized-event-types';
import { buildReplaySteps, replayStateAt } from './workflow-replay-engine';

const T0 = 1700000000000;
const MIN = 60_000;
const at = (m: number) => new Date(T0 + m * MIN).toISOString();

const timeline = (
  phases: [string, number][],
  spawns: [string, number][],
  tasks: [number, number, string][],
): WorkflowTimeline => ({
  phases: phases.map(([skill, m]) => ({ skill, ts: at(m) })),
  spawns: spawns.map(([agentType, m]) => ({ agentType, ts: at(m), depth: 1 })),
  tasks: tasks.map(([s, e, label]) => ({ startTs: at(s), endTs: at(e), label })),
});

describe('buildReplaySteps', () => {
  test('phases and spawns inside the task window become ordered steps', () => {
    const tl = timeline(
      [['brainstorm', 0], ['mk-plan', 3], ['cook', 6]],
      [['code-reviewer', 7], ['journal-writer', 8]],
      [[2, 10, 'do the thing']],
    );
    const r = buildReplaySteps(tl, 0);
    // window (2,10]: mk-plan@3, cook@6 (phases) + spawns@7,@8 under cook
    expect(r.steps.map((s) => `${s.kind}:${s.phaseKey}:${s.agentType ?? ''}@${s.offsetMs / MIN}`)).toEqual([
      'phase:mk-plan:@1',
      'phase:cook:@4',
      'spawn:cook:code-reviewer@5',
      'spawn:cook:journal-writer@6',
    ]);
    expect(r.durationMs).toBe(8 * MIN);
  });

  test('carry-in = the phase active when the task began', () => {
    const tl = timeline(
      [['brainstorm', 0], ['cook', 5]],
      [],
      [[3, 8, 'mid-cook task']],
    );
    const r = buildReplaySteps(tl, 0);
    // brainstorm@0 <= start@3 → carry-in brainstorm; cook@5 is a step
    expect(r.carryInPhase).toBe('brainstorm');
    expect(r.steps.map((s) => s.phaseKey)).toEqual(['cook']);
  });

  test('empty task (prompt immediately followed by next prompt) → no steps', () => {
    const tl = timeline([['cook', 0]], [], [[2, 2, 'noop'], [2, 5, 'real']]);
    const r = buildReplaySteps(tl, 0);
    expect(r.steps).toHaveLength(0);
    expect(r.durationMs).toBe(1); // clamped
    expect(r.carryInPhase).toBe('cook');
  });

  test('missing timeline / bad index → empty replay', () => {
    expect(buildReplaySteps(undefined, 0).steps).toHaveLength(0);
    expect(buildReplaySteps(timeline([['cook', 0]], [], [[0, 1, 'x']]), 9).steps).toHaveLength(0);
  });
});

describe('replayStateAt', () => {
  const tl = timeline(
    [['brainstorm', 0], ['mk-plan', 3], ['cook', 6]],
    [['code-reviewer', 7]],
    [[2, 10, 'task']],
  );
  const r = buildReplaySteps(tl, 0);

  test('playhead 0 = carry-in only', () => {
    const s = replayStateAt(r, 0);
    expect(s.activePhase).toBe('brainstorm'); // active at start
    expect([...s.revealedPhaseKeys]).toEqual(['brainstorm']);
    expect(s.revealedSpawns).toHaveLength(0);
  });

  test('playhead mid-window reveals up to that point, active = latest phase', () => {
    const s = replayStateAt(r, 4.5 * MIN); // past mk-plan@1 and cook@4, before spawn@5
    expect(s.activePhase).toBe('cook');
    expect([...s.revealedPhaseKeys].sort()).toEqual(['brainstorm', 'cook', 'mk-plan']);
    expect(s.revealedSpawns).toHaveLength(0);
  });

  test('playhead at end reveals everything incl. the spawn', () => {
    const s = replayStateAt(r, r.durationMs);
    expect(s.activePhase).toBe('cook');
    expect(s.revealedSpawns).toEqual([{ phaseKey: 'cook', agentType: 'code-reviewer' }]);
  });
});
