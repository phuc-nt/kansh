// Fixtures for the timeline swimlane engine: block merging, window clamping,
// open-branch handling, lane omission, element caps.

import { describe, expect, test } from 'bun:test';
import type { NormalizedEvent, SessionSnapshot } from '../shared/normalized-event-types';
import { layoutTimeline } from './timeline-layout-engine';

const T0 = 1700000000000;
const MIN = 60_000;

let seq = 1;
const ev = (kind: NormalizedEvent['kind'], atMs: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  sessionId: 's1',
  agentId: null,
  ts: new Date(atMs).toISOString(),
  seq: seq++,
  uuid: `u${seq}`,
  kind,
  ...extra,
});

const session = (events: NormalizedEvent[], extra: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  sessionId: extra.sessionId ?? 's1',
  project: 'p',
  cwd: '/tmp/proj-a',
  slug: 'test-slug',
  entrypoint: 'cli',
  status: 'ended',
  startedAt: new Date(T0).toISOString(),
  lastActivityAt: new Date(T0).toISOString(),
  model: '',
  totalTokensIn: 0,
  totalTokensOut: 0,
  contextTokens: 0,
  events,
  ...extra,
});

const WINDOW = { startMs: T0, endMs: T0 + 60 * MIN };

describe('layoutTimeline', () => {
  test('dense burst merges into one block with dominant category', () => {
    const events = [
      ev('tool-start', T0 + MIN, { toolName: 'Read', toolUseId: 'a' }),
      ev('tool-end', T0 + MIN + 5000, { toolUseId: 'a' }),
      ev('tool-start', T0 + MIN + 10_000, { toolName: 'Read', toolUseId: 'b' }),
      ev('tool-start', T0 + MIN + 20_000, { toolName: 'Bash', toolUseId: 'c' }),
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.blocks).toHaveLength(1);
    expect(lane.blocks[0].eventCount).toBe(4);
    expect(lane.blocks[0].dominantCategory).toBe('file');
  });

  test('gap > merge threshold splits blocks', () => {
    const events = [ev('user-message', T0 + MIN), ev('user-message', T0 + 10 * MIN)];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.blocks).toHaveLength(2);
  });

  test('events outside window are clamped/excluded and clipped flags set', () => {
    const events = [
      ev('user-message', T0 - 30 * MIN), // before window
      ev('user-message', T0 + 5 * MIN),
      ev('user-message', T0 + 90 * MIN), // after window
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.clippedLeft).toBe(true);
    expect(lane.clippedRight).toBe(true);
    for (const b of lane.blocks) {
      expect(b.startMs).toBeGreaterThanOrEqual(WINDOW.startMs);
      expect(b.endMs).toBeLessThanOrEqual(WINDOW.endMs);
    }
  });

  test('session entirely outside window is omitted', () => {
    const lanes = layoutTimeline(
      [session([ev('user-message', T0 - 120 * MIN)])],
      WINDOW,
      WINDOW.endMs,
    );
    expect(lanes).toHaveLength(0);
  });

  test('running session extends last block to now', () => {
    const events = [ev('tool-start', T0 + 5 * MIN, { toolName: 'Bash', toolUseId: 'x' })];
    const nowMs = T0 + 20 * MIN;
    const [lane] = layoutTimeline([session(events, { status: 'running' })], { startMs: T0, endMs: nowMs }, nowMs);
    expect(lane.blocks[0].endMs).toBe(nowMs);
  });

  test('open subagent at window edge yields endMs null; closed one is clamped', () => {
    const events = [
      ev('subagent-spawn', T0 + 5 * MIN, { agentId: 'A', toolUseId: 't1', agentType: 'Explore' }),
      ev('subagent-spawn', T0 + 6 * MIN, { agentId: 'B', toolUseId: 't2' }),
      ev('subagent-end', T0 + 10 * MIN, { agentId: 'B', toolUseId: 't2' }),
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    const a = lane.branches.find((b) => b.agentId === 'A');
    const b = lane.branches.find((b) => b.agentId === 'B');
    expect(a?.endMs).toBeNull();
    expect(a?.agentType).toBe('Explore');
    expect(b?.endMs).toBe(T0 + 10 * MIN);
    expect(a?.depth).toBe(1); // default when spawnDepth absent
  });

  test('lanes ordered by first in-window activity; two sessions overlap', () => {
    const early = session([ev('user-message', T0 + 2 * MIN, { sessionId: 'early' })], { sessionId: 'early', cwd: '/tmp/early' });
    const late = session([ev('user-message', T0 + 30 * MIN, { sessionId: 'late' })], { sessionId: 'late', cwd: '/tmp/late' });
    const lanes = layoutTimeline([late, early], WINDOW, WINDOW.endMs);
    expect(lanes.map((l) => l.sessionId)).toEqual(['early', 'late']);
  });

  test('block cap drops oldest and reports count', () => {
    // 250 isolated events, each its own block (spaced > merge gap)
    const events = Array.from({ length: 250 }, (_, i) => ev('user-message', T0 + i * 2 * MIN));
    const window = { startMs: T0, endMs: T0 + 600 * MIN };
    const [lane] = layoutTimeline([session(events)], window, window.endMs);
    expect(lane.blocks).toHaveLength(200);
    expect(lane.droppedBlocks).toBe(50);
    // newest kept
    expect(lane.blocks[lane.blocks.length - 1].startMs).toBe(T0 + 249 * 2 * MIN);
  });
});
