// Fixtures for the workflow-graph engine: phase collapsing, loop-weighted
// edges, subagent-to-phase tie by timestamp, caps, and degenerate cases.
// Input is the compact WorkflowTimeline (server-scanned), not raw events.

import { describe, expect, test } from 'bun:test';
import type { WorkflowTimeline } from '../shared/normalized-event-types';
import { buildWorkflowGraph, phaseOf } from './workflow-graph-engine';

const T0 = 1700000000000;
const MIN = 60_000;
const at = (m: number) => new Date(T0 + m * MIN).toISOString();

const timeline = (
  phases: [string, number][],
  spawns: [string, number][] = [],
): WorkflowTimeline => ({
  phases: phases.map(([skill, m]) => ({ skill, ts: at(m) })),
  spawns: spawns.map(([agentType, m]) => ({ agentType, ts: at(m), depth: 1 })),
});

const edge = (g: ReturnType<typeof buildWorkflowGraph>, from: string, to: string) =>
  g.edges.find((e) => e.from === from && e.to === to)?.weight ?? 0;

describe('phaseOf', () => {
  test('collapses raw skills into typed buckets', () => {
    expect(phaseOf('brainstorm')).toBe('brainstorm');
    expect(phaseOf('mk-plan')).toBe('mk-plan');
    expect(phaseOf('plan')).toBe('mk-plan');
    expect(phaseOf('cook')).toBe('cook');
    expect(phaseOf('journal')).toBe('journal');
    expect(phaseOf('research')).toBe('research');
    expect(phaseOf('chrome-devtools')).toBe('review');
    expect(phaseOf('react-best-practices')).toBe('review');
    expect(phaseOf('fix')).toBe('review');
    expect(phaseOf('claude-api')).toBe('other');
    expect(phaseOf('vercel-plugin:verification')).toBe('review');
  });
});

describe('buildWorkflowGraph', () => {
  test('collapses consecutive same-bucket phases, counts transitions', () => {
    const g = buildWorkflowGraph(
      timeline([
        ['brainstorm', 0],
        ['mk-plan', 2],
        ['chrome-devtools', 3],
        ['react-best-practices', 4], // both map to review — one visit
        ['cook', 5],
      ]),
    );
    expect(g.nodes.find((n) => n.key === 'review')?.visits).toBe(1);
    expect(edge(g, 'brainstorm', 'mk-plan')).toBe(1);
    expect(edge(g, 'mk-plan', 'review')).toBe(1);
    expect(edge(g, 'review', 'cook')).toBe(1);
    expect(g.phaseCount).toBe(4);
  });

  test('loop rhythm: repeated brainstorm→plan→cook thickens edges and counts loops', () => {
    const phases: [string, number][] = [];
    let m = 0;
    for (let round = 0; round < 3; round++) {
      phases.push(['brainstorm', m++], ['mk-plan', m++], ['cook', m++]);
    }
    const g = buildWorkflowGraph(timeline(phases));
    expect(edge(g, 'brainstorm', 'mk-plan')).toBe(3);
    expect(edge(g, 'mk-plan', 'cook')).toBe(3);
    expect(edge(g, 'cook', 'brainstorm')).toBe(2); // round boundaries
    expect(g.nodes.find((n) => n.key === 'cook')?.visits).toBe(3);
    expect(g.loopCount).toBeGreaterThanOrEqual(6);
  });

  test('active phase = last phase entered', () => {
    const g = buildWorkflowGraph(timeline([['brainstorm', 0], ['cook', 1], ['journal', 2]]));
    expect(g.nodes.find((n) => n.active)?.key).toBe('journal');
    expect(g.nodes.filter((n) => n.active)).toHaveLength(1);
  });

  test('subagents tie to the phase active at spawn time, grouped by type', () => {
    const g = buildWorkflowGraph(
      timeline(
        [['brainstorm', 0], ['cook', 5], ['journal', 10]],
        [
          ['code-reviewer', 6],
          ['code-reviewer', 7],
          ['journal-writer', 8], // still during cook
          ['journal-writer', 11], // during journal
        ],
      ),
    );
    expect(g.nodes.find((n) => n.key === 'cook')?.subagents).toEqual([
      { agentType: 'code-reviewer', count: 2 },
      { agentType: 'journal-writer', count: 1 },
    ]);
    expect(g.nodes.find((n) => n.key === 'journal')?.subagents).toEqual([
      { agentType: 'journal-writer', count: 1 },
    ]);
    expect(g.agentCount).toBe(4);
  });

  test('unknown skill → other', () => {
    const g = buildWorkflowGraph(timeline([['claude-api', 0]]));
    expect(g.nodes.map((n) => n.key)).toEqual(['other']);
  });

  test('empty timeline yields an empty graph', () => {
    expect(buildWorkflowGraph(undefined).nodes).toHaveLength(0);
    expect(buildWorkflowGraph(timeline([])).phaseCount).toBe(0);
  });

  test('subagent group cap keeps top 8 types, reports overflow', () => {
    const spawns: [string, number][] = [];
    for (let i = 0; i < 10; i++) spawns.push([`agent-${i}`, i + 1]);
    const g = buildWorkflowGraph(timeline([['cook', 0]], spawns));
    const cook = g.nodes.find((n) => n.key === 'cook');
    expect(cook?.subagents).toHaveLength(8);
    expect(cook?.hiddenSubagentTypes).toBe(2);
  });
});
