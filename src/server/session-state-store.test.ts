// Semantic-layer rules: mission/todos/pendingQuestion lifecycle, error streak,
// loop suspicion, and change-only broadcasting.

import { describe, expect, test } from 'bun:test';
import { SessionStateStore } from './session-state-store';
import type { ParsedEvent } from './transcript-record-parser';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let seq = 0;
const ev = (kind: ParsedEvent['kind'], extra: Partial<ParsedEvent> = {}): ParsedEvent => ({
  sessionId: SID,
  agentId: null,
  ts: new Date(1700000000000 + seq * 1000).toISOString(),
  uuid: `u${++seq}`,
  kind,
  ...extra,
});

function makeStore() {
  const semantics: unknown[] = [];
  const store = new SessionStateStore({
    onSessionAdded: () => {},
    onEvent: () => {},
    onStatusChange: () => {},
    onSemanticsChange: (_id, s) => semantics.push(s),
  });
  store.addSession(SID, 'proj', Date.now(), true);
  return { store, semantics };
}

describe('semantic layer', () => {
  test('mission = latest real user prompt; todos = latest TodoWrite', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [
      ev('user-message', { label: 'first task' }),
      ev('tool-start', { toolName: 'TodoWrite', toolUseId: 't1', todos: [{ content: 'a', status: 'pending' }] }),
      ev('user-message', { label: 'second task' }),
      ev('tool-start', {
        toolName: 'TodoWrite',
        toolUseId: 't2',
        todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }],
      }),
    ]);
    const [snap] = store.snapshotAll();
    expect(snap.mission).toBe('second task');
    expect(snap.todos).toHaveLength(2);
    expect(snap.todos?.[1].status).toBe('in_progress');
  });

  test('subagent todos/mission never overwrite the main lane', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [
      ev('user-message', { label: 'main mission' }),
      ev('tool-start', { agentId: 'sub1', toolName: 'TodoWrite', toolUseId: 's1', todos: [{ content: 'sub todo', status: 'pending' }] }),
      ev('user-message', { agentId: 'sub1', label: 'sub prompt' }),
    ]);
    const [snap] = store.snapshotAll();
    expect(snap.mission).toBe('main mission');
    expect(snap.todos).toBeUndefined();
  });

  test('pendingQuestion set on AskUserQuestion start, cleared by its tool-end', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [
      ev('tool-start', { toolName: 'AskUserQuestion', toolUseId: 'q1', question: 'Chọn stack nào?' }),
    ]);
    expect(store.snapshotAll()[0].pendingQuestion).toBe('Chọn stack nào?');
    store.applyEvents(SID, [ev('tool-end', { toolUseId: 'q1' })]);
    expect(store.snapshotAll()[0].pendingQuestion).toBeUndefined();
  });

  test('errorStreak counts consecutive errors, resets on success', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [
      ev('tool-end', { toolUseId: 'a', isError: true }),
      ev('tool-end', { toolUseId: 'b', isError: true }),
    ]);
    expect(store.snapshotAll()[0].errorStreak).toBe(2);
    store.applyEvents(SID, [ev('tool-end', { toolUseId: 'c' })]);
    expect(store.snapshotAll()[0].errorStreak).toBe(0);
  });

  test('loopSuspect survives interleaved unrelated tools (A,A,A,B keeps the badge)', () => {
    const { store } = makeStore();
    const bash = () => ev('tool-start', { toolName: 'Bash', toolUseId: `x${seq}`, label: 'bun test' });
    store.applyEvents(SID, [
      bash(), bash(), bash(),
      ev('tool-start', { toolName: 'Read', toolUseId: `r${seq}`, label: 'other.ts' }),
    ]);
    // one unrelated tool must NOT clear the badge — Bash still holds 3 ring slots
    expect(store.snapshotAll()[0].loopSuspect).toContain('Bash');
  });

  test('pendingQuestion cleared by a subsequent user message (interrupt path)', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [
      ev('tool-start', { toolName: 'AskUserQuestion', toolUseId: 'q9', question: 'Chọn gì?' }),
    ]);
    expect(store.snapshotAll()[0].pendingQuestion).toBe('Chọn gì?');
    // user interrupts and types something new — no tool_result ever lands
    store.applyEvents(SID, [ev('user-message', { label: 'làm cái khác đi' })]);
    expect(store.snapshotAll()[0].pendingQuestion).toBeUndefined();
  });

  test('loopSuspect fires on >=3 identical signatures in the window, clears on rotation', () => {
    const { store } = makeStore();
    const bash = () => ev('tool-start', { toolName: 'Bash', toolUseId: `x${seq}`, label: 'bun test' });
    store.applyEvents(SID, [bash(), bash(), bash()]);
    expect(store.snapshotAll()[0].loopSuspect).toContain('Bash');
    // 15 different signatures rotate the repeated one out
    store.applyEvents(
      SID,
      Array.from({ length: 15 }, (_, i) => ev('tool-start', { toolName: 'Read', toolUseId: `r${i}`, label: `f${i}` })),
    );
    expect(store.snapshotAll()[0].loopSuspect).toBeUndefined();
  });

  test('semantics broadcast only on change', () => {
    const { store, semantics } = makeStore();
    store.applyEvents(SID, [ev('user-message', { label: 'task' })]);
    store.applyEvents(SID, [ev('assistant-message', { label: 'thinking' })]); // no semantic change
    store.applyEvents(SID, [ev('user-message', { label: 'task' })]); // same mission
    expect(semantics).toHaveLength(1);
  });
});

describe('provenance layer', () => {
  test('title: latest wins, custom beats ai', () => {
    const { store } = makeStore();
    store.applyMeta(SID, { aiTitle: 'First generated title' });
    expect(store.snapshotAll()[0].title).toBe('First generated title');
    store.applyMeta(SID, { aiTitle: 'Regenerated title' });
    expect(store.snapshotAll()[0].title).toBe('Regenerated title');
    store.applyMeta(SID, { customTitle: 'kansh' });
    expect(store.snapshotAll()[0].title).toBe('kansh');
    store.applyMeta(SID, { aiTitle: 'Later regeneration' }); // custom still wins
    expect(store.snapshotAll()[0].title).toBe('kansh');
  });

  test('filesTouched aggregates edits/reads per path, hottest first, capped at 50', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [
      ev('tool-end', { toolUseId: 'e1', fileTouch: { path: '/p/hot.ts', action: 'edit' } }),
      ev('tool-end', { toolUseId: 'e2', fileTouch: { path: '/p/hot.ts', action: 'edit' } }),
      ev('tool-end', { toolUseId: 'e3', fileTouch: { path: '/p/hot.ts', action: 'read' } }),
      ev('tool-end', { toolUseId: 'e4', fileTouch: { path: '/p/cold.ts', action: 'read' } }),
    ]);
    const files = store.snapshotAll()[0].filesTouched;
    expect(files?.[0]).toMatchObject({ path: '/p/hot.ts', edits: 2, reads: 1 });
    expect(files?.[0].lastEditMs).toBeGreaterThan(0);
    expect(files?.[1]).toMatchObject({ path: '/p/cold.ts', edits: 0, reads: 1 });
    // cap: 60 distinct paths → 50 kept
    store.applyEvents(
      SID,
      Array.from({ length: 60 }, (_, i) =>
        ev('tool-end', { toolUseId: `c${i}`, fileTouch: { path: `/p/f${i}.ts`, action: 'read' } }),
      ),
    );
    expect(store.snapshotAll()[0].filesTouched?.length).toBe(50);
  });

  test('currentSkill set by attributed tool, expires after 10 unattributed tools', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [ev('tool-start', { toolName: 'Edit', toolUseId: 'k1', skill: 'cook' })]);
    expect(store.snapshotAll()[0].currentSkill).toBe('cook');
    store.applyEvents(
      SID,
      Array.from({ length: 9 }, (_, i) => ev('tool-start', { toolName: 'Read', toolUseId: `k${i + 2}` })),
    );
    expect(store.snapshotAll()[0].currentSkill).toBe('cook');
    store.applyEvents(SID, [ev('tool-start', { toolName: 'Read', toolUseId: 'k99' })]);
    expect(store.snapshotAll()[0].currentSkill).toBeUndefined();
  });

  test('blockedCount counts blocked events', () => {
    const { store } = makeStore();
    store.applyEvents(SID, [
      ev('tool-end', { toolUseId: 'b1', blocked: { kind: 'permission-rule' } }),
      ev('assistant-message', { blocked: { kind: 'hook-block', reason: 'tests failed' } }),
    ]);
    expect(store.snapshotAll()[0].blockedCount).toBe(2);
  });
});

describe('cross-session edit conflicts', () => {
  const SID2 = 'ffffffff-1111-2222-3333-444444444444';
  // anchored to real now: addSession seeds lastAppendMs with Date.now(), and
  // the ended-session branch needs nowMs to be genuinely later than that
  const NOW = Date.now();
  const liveBoth = { resumedSessionIds: new Set([SID, SID2]), freshProcessCwds: new Set<string>(), claudeProcessCount: 2 };

  function makeTwo() {
    const { store, semantics } = makeStore();
    store.addSession(SID2, 'proj2', Date.now(), true);
    return { store, semantics };
  }

  test('two live sessions editing the same file within the window conflict; ended sessions do not', () => {
    const { store } = makeTwo();
    const touch = (sid: string, uid: string) => {
      store.applyEvents(sid, [
        { sessionId: sid, agentId: null, ts: new Date(NOW - 60_000).toISOString(), uuid: uid, kind: 'tool-end', toolUseId: uid, fileTouch: { path: '/shared/config.ts', action: 'edit' } },
      ]);
    };
    touch(SID, 'x1');
    touch(SID2, 'x2');
    store.applyLivenessSample(liveBoth, NOW);
    const snaps = store.snapshotAll();
    for (const sid of [SID, SID2]) {
      const snap = snaps.find((s) => s.sessionId === sid);
      expect(snap?.conflicts?.[0].path).toBe('/shared/config.ts');
      expect(snap?.conflicts?.[0].otherSessionIds).toEqual([sid === SID ? SID2 : SID]);
    }
    // one session ends → conflict clears on both
    store.applyLivenessSample(
      { resumedSessionIds: new Set([SID]), freshProcessCwds: new Set<string>(), claudeProcessCount: 1 },
      NOW + 20_000,
    );
    for (const snap of store.snapshotAll()) expect(snap.conflicts).toBeUndefined();
  });

  test('edits older than 30min do not conflict; reads never conflict', () => {
    const { store } = makeTwo();
    store.applyEvents(SID, [
      { sessionId: SID, agentId: null, ts: new Date(NOW - 45 * 60_000).toISOString(), uuid: 'o1', kind: 'tool-end', toolUseId: 'o1', fileTouch: { path: '/shared/old.ts', action: 'edit' } },
    ]);
    store.applyEvents(SID2, [
      { sessionId: SID2, agentId: null, ts: new Date(NOW - 60_000).toISOString(), uuid: 'o2', kind: 'tool-end', toolUseId: 'o2', fileTouch: { path: '/shared/old.ts', action: 'edit' } },
      { sessionId: SID2, agentId: null, ts: new Date(NOW - 30_000).toISOString(), uuid: 'o3', kind: 'tool-end', toolUseId: 'o3', fileTouch: { path: '/shared/readme.md', action: 'read' } },
    ]);
    store.applyEvents(SID, [
      { sessionId: SID, agentId: null, ts: new Date(NOW - 20_000).toISOString(), uuid: 'o4', kind: 'tool-end', toolUseId: 'o4', fileTouch: { path: '/shared/readme.md', action: 'read' } },
    ]);
    store.applyLivenessSample(liveBoth, NOW);
    for (const snap of store.snapshotAll()) expect(snap.conflicts).toBeUndefined();
  });
});
