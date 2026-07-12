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
  /** top 2 tool names by call count inside the block */
  dominantTools: string[];
  tokensIn: number;
  tokensOut: number;
}

/** Semantic point on a lane: user prompt, error result, or pending question. */
export interface LaneMarker {
  ms: number;
  kind: 'prompt' | 'error' | 'question' | 'blocked';
  label?: string;
}

/** A period the session sat waiting for the user. */
export interface WaitingStretch {
  startMs: number;
  endMs: number;
  /** true = derived from the silence before a prompt (may be the user just away) */
  inferred: boolean;
}

export interface AttentionSummary {
  /** every main-lane user prompt across sessions, sorted by time */
  points: { ms: number; sessionId: string }[];
  /** consecutive prompt pairs landing on different sessions */
  switchCount: number;
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
  markers: LaneMarker[];
  waitingStretches: WaitingStretch[];
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
/** marker cap per lane; oldest drop first */
const MAX_MARKERS_PER_LANE = 80;
/** silence before a user prompt that counts as "session was waiting" */
const WAIT_MIN_MS = 2 * 60_000;

function displayLabel(session: SessionSnapshot): string {
  if (session.title) return session.title;
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
  const isLiveSession = session.status !== 'ended';
  // Ended sessions with no presence in the window are omitted. LIVE sessions
  // (running or waiting) always keep a lane — a monitor must not hide a
  // session that is waiting for the user just because it outlasted the window.
  if (!isLiveSession && (lastMs < window.startMs || firstMs > window.endMs)) return null;
  if (firstMs > window.endMs) return null; // starts after the window, nothing to show yet

  // --- activity blocks (+ enrichment: tool counts, token sums) ---
  interface RawBlock {
    startMs: number;
    endMs: number;
    categories: Map<ToolCategory, number>;
    tools: Map<string, number>;
    tokensIn: number;
    tokensOut: number;
    count: number;
  }
  const rawBlocks: RawBlock[] = [];
  for (const { event, ms } of timed) {
    const category = categoryOf(event);
    let block = rawBlocks[rawBlocks.length - 1];
    if (!(block && ms - block.endMs < BLOCK_MERGE_GAP_MS)) {
      block = { startMs: ms, endMs: ms, count: 0, categories: new Map(), tools: new Map(), tokensIn: 0, tokensOut: 0 };
      rawBlocks.push(block);
    }
    block.endMs = Math.max(block.endMs, ms);
    block.count++;
    block.categories.set(category, (block.categories.get(category) ?? 0) + 1);
    if (event.kind === 'tool-start' && event.toolName) {
      block.tools.set(event.toolName, (block.tools.get(event.toolName) ?? 0) + 1);
    }
    if (event.usage) {
      block.tokensIn += event.usage.in;
      block.tokensOut += event.usage.out;
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
      dominantTools: [...raw.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name),
      tokensIn: raw.tokensIn,
      tokensOut: raw.tokensOut,
    });
  }
  let droppedBlocks = 0;
  if (blocks.length > MAX_BLOCKS_PER_LANE) {
    droppedBlocks = blocks.length - MAX_BLOCKS_PER_LANE;
    blocks = blocks.slice(-MAX_BLOCKS_PER_LANE); // keep newest
  }
  // live sessions keep an empty lane (visible label + status, no blocks)
  if (blocks.length === 0 && !isLiveSession) return null;

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
  // Spans with no observed end: the deciding signal is the BRANCH'S OWN
  // recent activity, not session-wide lastMs — a long-running subagent keeps
  // emitting its own events, while a branch whose end fell outside the
  // replayed tail goes silent while the session moves on.
  const STALE_OPEN_MS = 10 * 60_000;
  const lastOwnActivity = new Map<string, number>();
  for (const { event, ms } of timed) {
    if (event.agentId) lastOwnActivity.set(event.agentId, ms);
  }
  const resolvedBranches = branches.map((b) => {
    if (b.endMs !== null) return b;
    const lastOwn = lastOwnActivity.get(b.agentId) ?? b.startMs;
    // branch silent while the session kept moving → end unseen; honest span
    // is spawn → its own last activity
    if (lastMs - lastOwn > STALE_OPEN_MS) return { ...b, endMs: lastOwn };
    // agent recently active: open on a live session, clamped on an ended one
    return isLiveSession ? b : { ...b, endMs: Math.min(lastMs, window.endMs) };
  });
  const visibleBranches = resolvedBranches
    .filter((b) => (b.endMs ?? nowMs) >= window.startMs && b.startMs <= window.endMs)
    .map((b) => ({
      ...b,
      startMs: Math.max(b.startMs, window.startMs),
      endMs: b.endMs === null ? null : Math.min(b.endMs, window.endMs),
    }));

  // --- semantic markers (main lane only; window-clamped; newest kept) ---
  const markers: LaneMarker[] = [];
  for (const { event, ms } of timed) {
    if (ms < window.startMs || ms > window.endMs) continue;
    if (event.agentId !== null) continue;
    if (event.kind === 'user-message' && event.label) {
      markers.push({ ms, kind: 'prompt', label: event.label });
    } else if (event.blocked) {
      // blocked beats plain error: a denial is a distinct intervention point
      markers.push({
        ms,
        kind: 'blocked',
        label: event.blocked.reason ?? event.blocked.kind,
      });
    } else if (event.kind === 'tool-end' && event.isError) {
      markers.push({ ms, kind: 'error' });
    } else if (event.kind === 'tool-start' && event.question) {
      markers.push({ ms, kind: 'question', label: event.question });
    }
  }
  const cappedMarkers =
    markers.length > MAX_MARKERS_PER_LANE ? markers.slice(-MAX_MARKERS_PER_LANE) : markers;

  // --- waiting stretches ---
  // Historical: silence before a user prompt = the session sat waiting
  // (inferred — the user may simply have been away). Live: waiting status now.
  const waitingStretches: WaitingStretch[] = [];
  let prevMs: number | null = null;
  for (const { event, ms } of timed) {
    if (prevMs !== null && event.agentId === null && event.kind === 'user-message' && ms - prevMs > WAIT_MIN_MS) {
      const startMs = Math.max(prevMs, window.startMs);
      const endMs = Math.min(ms, window.endMs);
      if (endMs > startMs) waitingStretches.push({ startMs, endMs, inferred: true });
    }
    prevMs = ms;
  }
  if (session.status === 'waiting' && lastMs < window.endMs) {
    const startMs = Math.max(lastMs, window.startMs);
    if (nowMs > startMs) {
      waitingStretches.push({ startMs, endMs: Math.min(nowMs, window.endMs), inferred: false });
    }
  }

  return {
    sessionId: session.sessionId,
    label: displayLabel(session),
    status: session.status,
    waitingReason: session.waitingReason,
    blocks,
    branches: visibleBranches,
    markers: cappedMarkers,
    waitingStretches,
    clippedLeft,
    clippedRight,
    droppedBlocks,
  };
}

/**
 * Where the user's attention went: every main-lane prompt across sessions,
 * plus how many times consecutive prompts landed on different sessions.
 * Separate from layoutTimeline so lane layout stays per-session pure.
 */
export function computeAttention(
  sessions: SessionSnapshot[],
  window: TimelineWindow,
): AttentionSummary {
  const points: { ms: number; sessionId: string }[] = [];
  for (const session of sessions) {
    for (const event of session.events) {
      if (event.agentId !== null || event.kind !== 'user-message' || !event.label) continue;
      const ms = Date.parse(event.ts);
      if (Number.isNaN(ms) || ms < window.startMs || ms > window.endMs) continue;
      points.push({ ms, sessionId: session.sessionId });
    }
  }
  points.sort((a, b) => a.ms - b.ms);
  let switchCount = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].sessionId !== points[i - 1].sessionId) switchCount++;
  }
  return { points, switchCount };
}

function categoryOf(event: NormalizedEvent): ToolCategory {
  if (event.kind === 'tool-start' || event.kind === 'tool-end') return toolCategory(event.toolName);
  if (event.kind === 'subagent-spawn' || event.kind === 'subagent-end') return 'agent';
  return 'other';
}

function dominant(categories: Map<ToolCategory, number>): ToolCategory {
  // prefer tool categories over 'other' (messages) — a block with 3 Reads and
  // 5 assistant messages is file work, not "other"
  let best: ToolCategory = 'other';
  let bestCount = -1;
  for (const [category, count] of categories) {
    if (category === 'other') continue;
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : 'other';
}
