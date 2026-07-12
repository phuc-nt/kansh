// Unit tests for the pure layout engine: branch/merge/column-reuse fixtures
// shaped like real transcript event streams.

import { describe, expect, test } from 'bun:test';
import type { NormalizedEvent } from '../shared/normalized-event-types';
import { layoutSessionGraph } from './graph-layout-engine';

let seqCounter = 1;
const ev = (
  kind: NormalizedEvent['kind'],
  opts: Partial<NormalizedEvent> & { t: number },
): NormalizedEvent => ({
  sessionId: 's1',
  agentId: null,
  ts: new Date(1700000000000 + opts.t * 1000).toISOString(),
  seq: seqCounter++,
  uuid: opts.uuid ?? `${kind}-${opts.t}-${seqCounter}`,
  kind,
  ...opts,
});

describe('layoutSessionGraph', () => {
  test('linear main lane connects consecutive nodes in column 0', () => {
    const layout = layoutSessionGraph([
      ev('user-message', { t: 0 }),
      ev('assistant-message', { t: 1 }),
      ev('tool-start', { t: 2, toolName: 'Bash', toolUseId: 'tu1' }),
      ev('tool-end', { t: 3, toolUseId: 'tu1' }),
    ]);
    expect(layout.nodes).toHaveLength(4);
    expect(layout.nodes.every((n) => n.column === 0)).toBe(true);
    expect(layout.edges.filter((e) => e.kind === 'lane')).toHaveLength(3);
    expect(layout.columnCount).toBe(1);
  });

  test('subagent branches out from its Task tool-start and merges into the tool-end', () => {
    const layout = layoutSessionGraph([
      ev('tool-start', { t: 0, uuid: 'task-start', toolName: 'Task', toolUseId: 'spawn1' }),
      ev('subagent-spawn', { t: 1, uuid: 'spawn', agentId: 'agentA', toolUseId: 'spawn1', agentType: 'Explore' }),
      ev('tool-start', { t: 2, uuid: 'sub-work', agentId: 'agentA', toolName: 'Read', toolUseId: 'tu2' }),
      ev('tool-end', { t: 3, agentId: 'agentA', toolUseId: 'tu2' }),
      ev('tool-end', { t: 4, uuid: 'task-end', toolUseId: 'spawn1' }),
      ev('subagent-end', { t: 4.5, uuid: 'merge', agentId: 'agentA', toolUseId: 'spawn1' }),
    ]);
    const spawnNode = layout.nodes.find((n) => n.uuid === 'spawn');
    expect(spawnNode?.column).toBe(1);
    expect(layout.edges).toContainEqual({ fromUuid: 'task-start', toUuid: 'spawn', kind: 'branch-out' });
    // merge from branch tip (last subagent node) into the parent tool-end
    const merge = layout.edges.find((e) => e.kind === 'merge-in');
    expect(merge?.toUuid).toBe('task-end');
    expect(layout.openBranchTips).toHaveLength(0);
  });

  test('concurrent subagents take distinct columns; columns are reused after merge', () => {
    const layout = layoutSessionGraph([
      ev('tool-start', { t: 0, uuid: 'ts-a', toolName: 'Task', toolUseId: 'a' }),
      ev('tool-start', { t: 1, uuid: 'ts-b', toolName: 'Task', toolUseId: 'b' }),
      ev('subagent-spawn', { t: 2, uuid: 'spawn-a', agentId: 'A', toolUseId: 'a' }),
      ev('subagent-spawn', { t: 3, uuid: 'spawn-b', agentId: 'B', toolUseId: 'b' }),
      ev('tool-end', { t: 4, uuid: 'te-a', toolUseId: 'a' }),
      ev('subagent-end', { t: 5, agentId: 'A', toolUseId: 'a' }),
      // C spawns after A merged — should reuse A's freed column
      ev('tool-start', { t: 6, uuid: 'ts-c', toolName: 'Task', toolUseId: 'c' }),
      ev('subagent-spawn', { t: 7, uuid: 'spawn-c', agentId: 'C', toolUseId: 'c' }),
    ]);
    const col = (uuid: string) => layout.nodes.find((n) => n.uuid === uuid)?.column;
    expect(col('spawn-a')).toBe(1);
    expect(col('spawn-b')).toBe(2);
    expect(col('spawn-c')).toBe(1); // reused
    expect(layout.openBranchTips).toHaveLength(2); // B and C still open
  });

  test('subagent-end without matching tool-end still closes the branch with a node', () => {
    const layout = layoutSessionGraph([
      ev('subagent-spawn', { t: 0, uuid: 'spawn', agentId: 'A', toolUseId: 'gone' }),
      ev('assistant-message', { t: 1, agentId: 'A' }),
      ev('subagent-end', { t: 2, uuid: 'end', agentId: 'A', toolUseId: 'gone' }),
    ]);
    expect(layout.nodes.some((n) => n.uuid === 'end')).toBe(true);
    expect(layout.openBranchTips).toHaveLength(0);
  });

  test('events out of ts order are laid out chronologically', () => {
    const layout = layoutSessionGraph([
      ev('assistant-message', { t: 5, uuid: 'later' }),
      ev('user-message', { t: 1, uuid: 'earlier' }),
    ]);
    expect(layout.nodes[0].uuid).toBe('earlier');
    expect(layout.nodes[1].uuid).toBe('later');
  });
});

describe('compression + gaps', () => {
  const minorRun = (n: number, startT: number) =>
    Array.from({ length: n }, (_, i) => ev('tool-end', { t: startT + i, toolUseId: `plain-${startT}-${i}` }));

  test('run of >=3 minor events condenses into one segment with lane continuity', () => {
    const layout = layoutSessionGraph([
      ev('user-message', { t: 0, uuid: 'head' }),
      ...minorRun(4, 1),
      ev('assistant-message', { t: 10, uuid: 'tail', label: 'done thinking' }),
    ]);
    expect(layout.condensed).toHaveLength(1);
    expect(layout.condensed[0].count).toBe(4);
    // condensed events are not rendered as nodes
    expect(layout.nodes.map((n) => n.uuid)).toEqual(['head', 'tail']);
    // lane edges pass through the segment: head -> segment -> tail
    const segUuid = layout.condensed[0].uuid;
    expect(layout.edges).toContainEqual({ fromUuid: 'head', toUuid: segUuid, kind: 'lane' });
    expect(layout.edges).toContainEqual({ fromUuid: segUuid, toUuid: 'tail', kind: 'lane' });
  });

  test('runs of <3 minors stay as normal nodes', () => {
    const layout = layoutSessionGraph([
      ev('user-message', { t: 0 }),
      ...minorRun(2, 1),
      ev('user-message', { t: 5 }),
    ]);
    expect(layout.condensed).toHaveLength(0);
    expect(layout.nodes).toHaveLength(4);
  });

  test('merge-target tool-end is NEVER compressed even inside a minor run', () => {
    const layout = layoutSessionGraph([
      ev('tool-start', { t: 0, uuid: 'task', toolName: 'Task', toolUseId: 'spawnX' }),
      ev('subagent-spawn', { t: 1, uuid: 'sp', agentId: 'X', toolUseId: 'spawnX' }),
      ...minorRun(3, 2),
      ev('tool-end', { t: 6, uuid: 'task-end', toolUseId: 'spawnX' }), // merge target amid minors
      ...minorRun(3, 7),
      ev('subagent-end', { t: 11, agentId: 'X', toolUseId: 'spawnX' }),
      ev('user-message', { t: 12, uuid: 'after' }),
    ]);
    expect(layout.nodes.some((n) => n.uuid === 'task-end')).toBe(true);
    const merge = layout.edges.find((e) => e.kind === 'merge-in');
    expect(merge?.toUuid).toBe('task-end');
  });

  test('expanded segment renders its events as normal nodes', () => {
    const events = [ev('user-message', { t: 0 }), ...minorRun(4, 1), ev('user-message', { t: 9 })];
    const collapsed = layoutSessionGraph(events);
    const expanded = layoutSessionGraph(events, { expanded: new Set([collapsed.condensed[0].uuid]) });
    expect(expanded.condensed).toHaveLength(0);
    expect(expanded.nodes).toHaveLength(6);
  });

  test('idle gap >2min inserts a gap row; dense activity does not', () => {
    const layout = layoutSessionGraph([
      ev('user-message', { t: 0 }),
      ev('assistant-message', { t: 10, label: 'x' }),
      ev('user-message', { t: 10 + 300 }), // 5 minutes later
    ]);
    expect(layout.gaps).toHaveLength(1);
    expect(layout.gaps[0].durationMs).toBeGreaterThanOrEqual(4 * 60 * 1000);
  });

  test('last event of a lane is never compressed (pulse target)', () => {
    const layout = layoutSessionGraph([ev('user-message', { t: 0, uuid: 'u' }), ...minorRun(3, 1)]);
    // trailing run: the final minor stays a node so the live pulse has a target
    const lastMinorUuid = layout.nodes[layout.nodes.length - 1].uuid;
    expect(layout.condensed.flatMap((c) => c.uuids)).not.toContain(lastMinorUuid);
  });
});
