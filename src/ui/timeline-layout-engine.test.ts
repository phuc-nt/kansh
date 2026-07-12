// Fixtures for the timeline swimlane engine: block merging, window clamping,
// open-branch handling, lane omission, element caps.

import { describe, expect, test } from 'bun:test';
import type { NormalizedEvent, SessionSnapshot } from '../shared/normalized-event-types';
import { computeAttention, layoutTimeline } from './timeline-layout-engine';

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
  totalTokensCacheRead: 0,
  contextTokens: 0,
  errorStreak: 0,
  blockedCount: 0,
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

  test('open subagent stays null only on a running session near the tip', () => {
    const events = [
      ev('subagent-spawn', T0 + 5 * MIN, { agentId: 'A', toolUseId: 't1', agentType: 'Explore' }),
      ev('subagent-spawn', T0 + 6 * MIN, { agentId: 'B', toolUseId: 't2' }),
      ev('subagent-end', T0 + 10 * MIN, { agentId: 'B', toolUseId: 't2' }),
    ];
    // running session, spawn within the stale threshold of last activity → truly open
    const [running] = layoutTimeline([session(events, { status: 'running' })], WINDOW, WINDOW.endMs);
    const a = running.branches.find((b) => b.agentId === 'A');
    const b = running.branches.find((b) => b.agentId === 'B');
    expect(a?.endMs).toBeNull();
    expect(a?.agentType).toBe('Explore');
    expect(b?.endMs).toBe(T0 + 10 * MIN);
    expect(a?.depth).toBe(1); // default when spawnDepth absent

    // ended session: unseen end clamps to last activity instead of full width
    const [ended] = layoutTimeline([session(events, { status: 'ended' })], WINDOW, WINDOW.endMs);
    expect(ended.branches.find((br) => br.agentId === 'A')?.endMs).toBe(T0 + 10 * MIN);
  });

  test('silent open span (session moved on without the branch) clamps to its own last activity', () => {
    const events = [
      ev('subagent-spawn', T0 + MIN, { agentId: 'A', toolUseId: 't1' }),
      ev('assistant-message', T0 + 3 * MIN, { agentId: 'A', label: 'work' }),
      ev('user-message', T0 + 30 * MIN), // session kept moving; A went silent, end unseen
    ];
    const [lane] = layoutTimeline([session(events, { status: 'running' })], WINDOW, WINDOW.endMs);
    expect(lane.branches[0].endMs).toBe(T0 + 3 * MIN); // spawn -> A's own last activity
  });

  test('genuinely long-running subagent (own recent activity) stays open', () => {
    const events = [
      ev('subagent-spawn', T0 + MIN, { agentId: 'A', toolUseId: 't1' }),
      // A keeps working for 25 minutes — its own events advance with the session
      ...Array.from({ length: 5 }, (_, i) =>
        ev('tool-start', T0 + (5 + i * 5) * MIN, { agentId: 'A', toolName: 'Read', toolUseId: `r${i}` }),
      ),
    ];
    const [lane] = layoutTimeline([session(events, { status: 'running' })], WINDOW, WINDOW.endMs);
    expect(lane.branches[0].endMs).toBeNull(); // still open, not collapsed
  });

  test('waiting session keeps its lane even with no in-window activity', () => {
    const events = [ev('user-message', T0 - 120 * MIN)]; // all activity before window
    const lanes = layoutTimeline(
      [session(events, { status: 'waiting', waitingReason: 'user-turn' })],
      WINDOW,
      WINDOW.endMs,
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0].blocks).toHaveLength(0);
    expect(lanes[0].status).toBe('waiting');
  });

  test('spawnDepth threads through to branch span depth', () => {
    const events = [
      ev('subagent-spawn', T0 + MIN, { agentId: 'X', toolUseId: 'tx', spawnDepth: 2 }),
      ev('subagent-end', T0 + 2 * MIN, { agentId: 'X', toolUseId: 'tx' }),
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.branches[0].depth).toBe(2);
  });

  test('lanes ordered by first in-window activity; two sessions overlap', () => {
    const early = session([ev('user-message', T0 + 2 * MIN, { sessionId: 'early' })], { sessionId: 'early', cwd: '/tmp/early' });
    const late = session([ev('user-message', T0 + 30 * MIN, { sessionId: 'late' })], { sessionId: 'late', cwd: '/tmp/late' });
    const lanes = layoutTimeline([late, early], WINDOW, WINDOW.endMs);
    expect(lanes.map((l) => l.sessionId)).toEqual(['early', 'late']);
  });

  test('markers: prompt/error/question land at the right ms with labels', () => {
    const events = [
      ev('user-message', T0 + 2 * MIN, { label: 'làm task X' }),
      ev('tool-end', T0 + 3 * MIN, { toolUseId: 'e1', isError: true }),
      ev('tool-start', T0 + 4 * MIN, { toolName: 'AskUserQuestion', toolUseId: 'q1', question: 'Chọn gì?' }),
      ev('user-message', T0 + 5 * MIN, { agentId: 'sub', label: 'subagent prompt — không tính' }),
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.markers).toHaveLength(3);
    expect(lane.markers.map((m) => m.kind)).toEqual(['prompt', 'error', 'question']);
    expect(lane.markers[0].label).toBe('làm task X');
    expect(lane.markers[0].ms).toBe(T0 + 2 * MIN);
    expect(lane.markers[2].label).toBe('Chọn gì?');
  });

  test('markers outside window excluded; cap keeps newest 80', () => {
    const events = [
      ev('user-message', T0 - 10 * MIN, { label: 'trước window' }),
      ...Array.from({ length: 90 }, (_, i) => ev('user-message', T0 + i * 20_000, { label: `p${i}` })),
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.markers.length).toBe(80);
    expect(lane.markers[lane.markers.length - 1].label).toBe('p89');
    expect(lane.markers.some((m) => m.label === 'trước window')).toBe(false);
  });

  test('waiting stretch inferred from gap before a prompt; dense turnaround has none', () => {
    const events = [
      ev('assistant-message', T0 + 2 * MIN, { label: 'xong việc' }),
      ev('user-message', T0 + 12 * MIN, { label: 'việc mới' }), // 10min gap → waited
      ev('assistant-message', T0 + 12 * MIN + 30_000, { label: 'ok' }),
      ev('user-message', T0 + 13 * MIN, { label: 'tiếp' }), // 30s gap → none
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.waitingStretches).toHaveLength(1);
    expect(lane.waitingStretches[0]).toMatchObject({
      startMs: T0 + 2 * MIN,
      endMs: T0 + 12 * MIN,
      inferred: true,
    });
  });

  test('live waiting session gets a non-inferred stretch to now', () => {
    const nowMs = T0 + 30 * MIN;
    const events = [ev('assistant-message', T0 + 5 * MIN, { label: 'done' })];
    const [lane] = layoutTimeline(
      [session(events, { status: 'waiting', waitingReason: 'user-turn' })],
      { startMs: T0, endMs: nowMs },
      nowMs,
    );
    const live = lane.waitingStretches.find((w) => !w.inferred);
    expect(live).toMatchObject({ startMs: T0 + 5 * MIN, endMs: nowMs });
  });

  test('block enrichment: dominant tools and token sums', () => {
    const events = [
      ev('tool-start', T0 + MIN, { toolName: 'Read', toolUseId: 'a' }),
      ev('tool-start', T0 + MIN + 5000, { toolName: 'Read', toolUseId: 'b' }),
      ev('tool-start', T0 + MIN + 10_000, { toolName: 'Bash', toolUseId: 'c' }),
      ev('assistant-message', T0 + MIN + 15_000, {
        label: 'x',
        usage: { in: 100, out: 200, cacheRead: 0, cacheCreation: 0 },
      }),
    ];
    const [lane] = layoutTimeline([session(events)], WINDOW, WINDOW.endMs);
    expect(lane.blocks[0].dominantTools).toEqual(['Read', 'Bash']);
    expect(lane.blocks[0].tokensIn).toBe(100);
    expect(lane.blocks[0].tokensOut).toBe(200);
  });

  test('attention: points sorted across sessions, switchCount counts transitions', () => {
    const a = session(
      [
        ev('user-message', T0 + 1 * MIN, { sessionId: 'A', label: 'a1' }),
        ev('user-message', T0 + 5 * MIN, { sessionId: 'A', label: 'a2' }),
      ],
      { sessionId: 'A', cwd: '/w/a' },
    );
    const b = session(
      [ev('user-message', T0 + 3 * MIN, { sessionId: 'B', label: 'b1' })],
      { sessionId: 'B', cwd: '/w/b' },
    );
    const attention = computeAttention([a, b], WINDOW);
    expect(attention.points.map((p) => p.sessionId)).toEqual(['A', 'B', 'A']);
    expect(attention.switchCount).toBe(2); // A→B, B→A
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
