// Pure layout for the global timeline view: sessions -> horizontal swimlanes
// on a shared wall-clock window. Events aggregate into activity BLOCKS (not
// per-event dots — bursts would be unreadable); subagent lifetimes become
// branch spans. No Date.now() inside: `nowMs` is an input, keeping the
// function deterministic and testable.

import type { NormalizedEvent, SessionSnapshot } from '../shared/normalized-event-types';
import { toolCategory, type ToolCategory } from './tool-category-mapping';

export interface TimelineWindow {
  startMs: number;
  endMs: number;
}

export interface ActivityBlock {
  startMs: number;
  endMs: number;
  eventCount: number;
  dominantCategory: ToolCategory;
}

export interface BranchSpan {
  startMs: number;
  /** null = still open (running past the window's right edge or live) */
  endMs: number | null;
  agentId: string;
  agentType?: string;
  /** nesting level from meta.json spawnDepth (1 = direct child) */
  depth: number;
}

export interface TimelineLane {
  sessionId: string;
  label: string;
  status: SessionSnapshot['status'];
  waitingReason?: SessionSnapshot['waitingReason'];
  blocks: ActivityBlock[];
  branches: BranchSpan[];
  /** activity continues beyond the window edge */
  clippedLeft: boolean;
  clippedRight: boolean;
  /** blocks dropped by the per-lane element cap (0 = none) */
  droppedBlocks: number;
}

/** consecutive events closer than this merge into one activity block */
const BLOCK_MERGE_GAP_MS = 60_000;
/** visual element cap per lane; oldest blocks drop first */
const MAX_BLOCKS_PER_LANE = 200;

function displayLabel(session: SessionSnapshot): string {
  if (session.cwd) return session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  return session.slug || session.sessionId.slice(0, 8);
}

export function layoutTimeline(
  sessions: SessionSnapshot[],
  window: TimelineWindow,
  nowMs: number,
): TimelineLane[] {
  const lanes: TimelineLane[] = [];

  for (const session of sessions) {
    const lane = layoutLane(session, window, nowMs);
    if (lane) lanes.push(lane);
  }

  // order by first in-window activity so concurrent work reads top-down
  lanes.sort((a, b) => (a.blocks[0]?.startMs ?? Infinity) - (b.blocks[0]?.startMs ?? Infinity));
  return lanes;
}

function layoutLane(
  session: SessionSnapshot,
  window: TimelineWindow,
  nowMs: number,
): TimelineLane | null {
  // events sorted by ts (client store appends roughly ordered; sort to be safe)
  const timed = session.events
    .map((event) => ({ event, ms: Date.parse(event.ts) }))
    .filter((e) => !Number.isNaN(e.ms))
    .sort((a, b) => a.ms - b.ms);
  if (timed.length === 0) return null;

  const firstMs = timed[0].ms;
  const lastMs = timed[timed.length - 1].ms;
  // lane omitted when the session has no presence in the window at all
  // (a running session idle since before the window still shows via its
  // open trailing block only if its last event is inside; decided: omit)
  if (lastMs < window.startMs || firstMs > window.endMs) return null;

  // --- activity blocks ---
  const rawBlocks: Array<{ startMs: number; endMs: number; categories: Map<ToolCategory, number>; count: number }> = [];
  for (const { event, ms } of timed) {
    const category = categoryOf(event);
    const last = rawBlocks[rawBlocks.length - 1];
    if (last && ms - last.endMs < BLOCK_MERGE_GAP_MS) {
      last.endMs = ms;
      last.count++;
      last.categories.set(category, (last.categories.get(category) ?? 0) + 1);
    } else {
      rawBlocks.push({ startMs: ms, endMs: ms, count: 1, categories: new Map([[category, 1]]) });
    }
  }
  // a running session's last block extends to now (work in progress)
  if (session.status === 'running' && rawBlocks.length > 0) {
    rawBlocks[rawBlocks.length - 1].endMs = Math.max(rawBlocks[rawBlocks.length - 1].endMs, nowMs);
  }

  const clippedLeft = firstMs < window.startMs;
  const clippedRight = lastMs > window.endMs;

  // clamp to window, drop blocks fully outside
  let blocks: ActivityBlock[] = [];
  for (const raw of rawBlocks) {
    if (raw.endMs < window.startMs || raw.startMs > window.endMs) continue;
    blocks.push({
      startMs: Math.max(raw.startMs, window.startMs),
      endMs: Math.min(raw.endMs, window.endMs),
      eventCount: raw.count,
      dominantCategory: dominant(raw.categories),
    });
  }
  let droppedBlocks = 0;
  if (blocks.length > MAX_BLOCKS_PER_LANE) {
    droppedBlocks = blocks.length - MAX_BLOCKS_PER_LANE;
    blocks = blocks.slice(-MAX_BLOCKS_PER_LANE); // keep newest
  }
  if (blocks.length === 0) return null;

  // --- branch spans (subagent lifetimes) ---
  const branches: BranchSpan[] = [];
  const openByAgent = new Map<string, BranchSpan>();
  for (const { event, ms } of timed) {
    if (event.kind === 'subagent-spawn' && event.agentId) {
      const span: BranchSpan = {
        startMs: ms,
        endMs: null,
        agentId: event.agentId,
        agentType: event.agentType,
        depth: typeof event.spawnDepth === 'number' ? event.spawnDepth : 1,
      };
      openByAgent.set(event.agentId, span);
      branches.push(span);
    } else if (event.kind === 'subagent-end' && event.agentId) {
      const span = openByAgent.get(event.agentId);
      if (span) {
        span.endMs = ms;
        openByAgent.delete(event.agentId);
      }
    }
  }
  const visibleBranches = branches
    .filter((b) => (b.endMs ?? nowMs) >= window.startMs && b.startMs <= window.endMs)
    .map((b) => ({
      ...b,
      startMs: Math.max(b.startMs, window.startMs),
      endMs: b.endMs === null ? null : Math.min(b.endMs, window.endMs),
    }));

  return {
    sessionId: session.sessionId,
    label: displayLabel(session),
    status: session.status,
    waitingReason: session.waitingReason,
    blocks,
    branches: visibleBranches,
    clippedLeft,
    clippedRight,
    droppedBlocks,
  };
}

function categoryOf(event: NormalizedEvent): ToolCategory {
  if (event.kind === 'tool-start' || event.kind === 'tool-end') return toolCategory(event.toolName);
  if (event.kind === 'subagent-spawn' || event.kind === 'subagent-end') return 'agent';
  return 'other';
}

function dominant(categories: Map<ToolCategory, number>): ToolCategory {
  let best: ToolCategory = 'other';
  let bestCount = -1;
  for (const [category, count] of categories) {
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}
