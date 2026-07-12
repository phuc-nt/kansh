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
