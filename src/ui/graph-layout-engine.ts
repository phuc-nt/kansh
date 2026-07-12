// Pure layout: NormalizedEvent[] -> git-graph geometry (nodes, edges, columns,
// condensed segments, idle-gap markers).
// Column 0 is the main agent; each live subagent takes the lowest free column
// and releases it when its branch merges back. Rows follow (ts, seq) order —
// compact event order, not wall-clock scale. Long silences become explicit
// gap rows; runs of "minor" plumbing events condense into one `⋮ n` row.

import type { NormalizedEvent } from '../shared/normalized-event-types';

export interface GraphNode {
  uuid: string;
  row: number;
  column: number;
  event: NormalizedEvent;
}

/** A run of >=MIN_RUN minor events collapsed into a single row. */
export interface CondensedSegment {
  /** stable key (also the expansion toggle key): condensed-<first event uuid> */
  uuid: string;
  row: number;
  column: number;
  count: number;
  uuids: string[];
}

/** An idle-time marker row (no lane binding). */
export interface GapMarker {
  uuid: string;
  row: number;
  durationMs: number;
}

export type EdgeKind = 'lane' | 'branch-out' | 'merge-in';

export interface GraphEdge {
  fromUuid: string;
  toUuid: string;
  kind: EdgeKind;
}

export interface SessionGraphLayout {
  nodes: GraphNode[];
  condensed: CondensedSegment[];
  gaps: GapMarker[];
  edges: GraphEdge[];
  /** total rows used (nodes + condensed + gaps) for viewport height */
  rowCount: number;
  /** number of columns the graph occupies (>=1) */
  columnCount: number;
  /** agent branches that never merged (still running) — their last node uuids */
  openBranchTips: string[];
}

export interface LayoutOptions {
  /** condensed-segment uuids the user expanded back into full nodes */
  expanded?: Set<string>;
}

/** Branches beyond this many concurrent columns stack into the last column. */
const MAX_COLUMNS = 5;
/** minimum consecutive minor events to condense */
const MIN_RUN = 3;
/** silence between consecutive events that earns an idle marker */
const GAP_THRESHOLD_MS = 2 * 60 * 1000;

export function layoutSessionGraph(
  events: NormalizedEvent[],
  opts: LayoutOptions = {},
): SessionGraphLayout {
  const expanded = opts.expanded ?? new Set<string>();
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);

  // --- prescan: what must never be compressed ---
  // merge targets = tool-ends whose toolUseId belongs to a subagent spawn
  const spawnToolUseIds = new Set<string>();
  const lastUuidByLane = new Map<string, string>();
  for (const event of sorted) {
    if (event.kind === 'subagent-spawn' && event.toolUseId) spawnToolUseIds.add(event.toolUseId);
    lastUuidByLane.set(event.agentId ?? '', event.uuid);
  }
  const isMinor = (event: NormalizedEvent): boolean => {
    if (lastUuidByLane.get(event.agentId ?? '') === event.uuid) return false; // pulse target
    if (event.kind === 'tool-end') {
      return !event.toolUseId || !spawnToolUseIds.has(event.toolUseId); // merge targets stay visible
    }
    if (event.kind === 'assistant-message') return !event.label; // empty assistant turns only
    return false;
  };

  // --- lane/geometry state ---
  const nodes: GraphNode[] = [];
  const condensed: CondensedSegment[] = [];
  const gaps: GapMarker[] = [];
  const edges: GraphEdge[] = [];
  const laneKey = (agentId: string | null) => agentId ?? '';
  /** last laid-out element per lane (real node or condensed pseudo-node) */
  const lastByLane = new Map<string, { uuid: string; row: number; column: number }>();
  const columnByLane = new Map<string, number>([['', 0]]);
  const usedColumns = new Set<number>([0]);
  const toolStartByUseId = new Map<string, GraphNode>();
  const toolEndByUseId = new Map<string, GraphNode>();
  let maxColumn = 0;
  let row = 0;

  const takeColumn = (): number => {
    for (let c = 1; c < MAX_COLUMNS; c++) {
      if (!usedColumns.has(c)) {
        usedColumns.add(c);
        return c;
      }
    }
    return MAX_COLUMNS; // overflow column, shared
  };

  const laneColumn = (lane: string, agentId: string | null): number => {
    let column = columnByLane.get(lane);
    if (column === undefined) {
      column = agentId === null ? 0 : takeColumn();
      columnByLane.set(lane, column);
    }
    maxColumn = Math.max(maxColumn, column);
    return column;
  };

  const placeNode = (event: NormalizedEvent): void => {
    const lane = laneKey(event.agentId);
    const column = laneColumn(lane, event.agentId);
    const node: GraphNode = { uuid: event.uuid, row: row++, column, event };
    nodes.push(node);
    if (event.toolUseId) {
      if (event.kind === 'tool-start') toolStartByUseId.set(event.toolUseId, node);
      else if (event.kind === 'tool-end') toolEndByUseId.set(event.toolUseId, node);
    }
    const previous = lastByLane.get(lane);
    if (previous) {
      edges.push({ fromUuid: previous.uuid, toUuid: node.uuid, kind: 'lane' });
    } else if (event.kind === 'subagent-spawn') {
      // branch-out: anchor at the Task tool-start with the same toolUseId,
      // falling back to the latest main-lane element
      const anchor =
        (event.toolUseId && toolStartByUseId.get(event.toolUseId)) || lastByLane.get('');
      if (anchor) edges.push({ fromUuid: anchor.uuid, toUuid: node.uuid, kind: 'branch-out' });
    }
    lastByLane.set(lane, node);
  };

  // --- minor-run buffering ---
  let run: NormalizedEvent[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    const key = `condensed-${run[0].uuid}`;
    if (run.length >= MIN_RUN && !expanded.has(key)) {
      const lane = laneKey(run[0].agentId);
      const column = laneColumn(lane, run[0].agentId);
      const segment: CondensedSegment = {
        uuid: key,
        row: row++,
        column,
        count: run.length,
        uuids: run.map((e) => e.uuid),
      };
      condensed.push(segment);
      const previous = lastByLane.get(lane);
      if (previous) edges.push({ fromUuid: previous.uuid, toUuid: segment.uuid, kind: 'lane' });
      lastByLane.set(lane, segment);
    } else {
      for (const event of run) placeNode(event);
    }
    run = [];
  };

  // --- main pass ---
  let prevTsMs: number | null = null;
  for (const event of sorted) {
    // idle marker between consecutive events, regardless of lane
    const tsMs = Date.parse(event.ts);
    if (prevTsMs !== null && tsMs - prevTsMs > GAP_THRESHOLD_MS) {
      flushRun();
      gaps.push({ uuid: `gap-${event.uuid}`, row: row++, durationMs: tsMs - prevTsMs });
    }
    prevTsMs = Number.isNaN(tsMs) ? prevTsMs : tsMs;

    if (event.kind === 'subagent-end') {
      flushRun();
      // merge: edge from the branch tip to the matching main-lane tool-end
      // node; without one, the end renders as a closing node on the branch.
      const lane = laneKey(event.agentId);
      const branchTip = lastByLane.get(lane);
      const column = columnByLane.get(lane);
      if (column !== undefined && column !== MAX_COLUMNS) usedColumns.delete(column);
      columnByLane.delete(lane);
      lastByLane.delete(lane);
      if (branchTip) {
        const mergeTarget = (event.toolUseId && toolEndByUseId.get(event.toolUseId)) || null;
        if (mergeTarget) {
          edges.push({ fromUuid: branchTip.uuid, toUuid: mergeTarget.uuid, kind: 'merge-in' });
        } else {
          const node: GraphNode = { uuid: event.uuid, row: row++, column: branchTip.column, event };
          nodes.push(node);
          edges.push({ fromUuid: branchTip.uuid, toUuid: node.uuid, kind: 'lane' });
        }
      }
      continue;
    }

    if (isMinor(event)) {
      // runs must be same-lane and consecutive
      if (run.length > 0 && laneKey(run[0].agentId) !== laneKey(event.agentId)) flushRun();
      run.push(event);
      continue;
    }

    flushRun();
    placeNode(event);
  }
  flushRun();

  const openBranchTips = [...lastByLane.entries()]
    .filter(([lane]) => lane !== '')
    .map(([, element]) => element.uuid);

  return { nodes, condensed, gaps, edges, rowCount: row, columnCount: maxColumn + 1, openBranchTips };
}
