// In-memory session state: applies normalized events, tracks metadata and
// liveness status, and serializes snapshots for newly connected UI clients.
// Long-running daemon: sessions past the history window are evicted (see
// evictSessionsOlderThan), keeping memory bounded.

import type {
  NormalizedEvent,
  SessionSnapshot,
  SessionStatus,
} from '../shared/normalized-event-types';
import type { ParsedEvent, SessionMetaFields } from './transcript-record-parser';
import type { LivenessSample } from './session-liveness-poller';

/** Per-session cap keeps memory bounded regardless of transcript size. */
const MAX_EVENTS_PER_SESSION = 2000;
/** Appends within this window mean the session is actively working. */
const ACTIVE_MTIME_WINDOW_MS = 15_000;

interface SessionState {
  sessionId: string;
  project: string;
  cwd: string;
  slug: string;
  entrypoint: string;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  lastAppendMs: number;
  events: NormalizedEvent[];
  model: string;
  totalTokensIn: number;
  totalTokensOut: number;
  contextTokens: number;
  waitingReason?: 'permission' | 'user-turn';
  /** kind of the most recent main-lane event, drives waitingReason */
  lastMainEventKind?: NormalizedEvent['kind'];
}

export interface StoreListeners {
  onSessionAdded: (snapshot: SessionSnapshot) => void;
  onEvent: (event: NormalizedEvent) => void;
  onStatusChange: (
    sessionId: string,
    status: SessionStatus,
    lastActivityAt: string,
    waitingReason?: 'permission' | 'user-turn',
  ) => void;
}

export class SessionStateStore {
  private sessions = new Map<string, SessionState>();
  /** global monotonic sequence, assigned in apply order */
  private nextSeq = 1;

  constructor(private listeners: StoreListeners) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Register a session; emits session-added once (quiet=true during startup replay). */
  addSession(sessionId: string, project: string, mtimeMs: number, quiet = false): void {
    if (this.sessions.has(sessionId)) return;
    const nowIso = new Date(mtimeMs).toISOString();
    const state: SessionState = {
      sessionId,
      project,
      cwd: '',
      slug: '',
      entrypoint: '',
      status: 'ended',
      startedAt: nowIso,
      lastActivityAt: nowIso,
      lastAppendMs: mtimeMs,
      events: [],
      model: '',
      totalTokensIn: 0,
      totalTokensOut: 0,
      contextTokens: 0,
    };
    this.sessions.set(sessionId, state);
    if (!quiet) this.listeners.onSessionAdded(this.toSnapshot(state));
  }

  /** Merge metadata fields scraped from transcript records (first-wins). */
  applyMeta(sessionId: string, meta: SessionMetaFields): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (meta.cwd && !state.cwd) state.cwd = meta.cwd;
    if (meta.slug && !state.slug) state.slug = meta.slug;
    if (meta.entrypoint && !state.entrypoint) state.entrypoint = meta.entrypoint;
  }

  /** Assign seq numbers and append; broadcasts unless quiet (startup replay). */
  applyEvents(sessionId: string, events: ParsedEvent[], quiet = false): void {
    const state = this.sessions.get(sessionId);
    if (!state || events.length === 0) return;
    for (const parsed of events) {
      const event: NormalizedEvent = { ...parsed, seq: this.nextSeq++ };
      state.events.push(event);
      // usage rides on the first event of each assistant turn — safe to sum
      if (event.usage) {
        state.totalTokensIn += event.usage.in;
        state.totalTokensOut += event.usage.out;
        if (event.agentId === null) {
          // context size ≈ everything the latest main turn read:
          // fresh input + cache hits + cache being written this turn
          state.contextTokens = event.usage.in + event.usage.cacheRead + event.usage.cacheCreation;
        }
      }
      if (event.model && event.agentId === null) state.model = event.model;
      if (event.agentId === null) state.lastMainEventKind = event.kind;
      if (!quiet) this.listeners.onEvent(event);
    }
    if (state.events.length > MAX_EVENTS_PER_SESSION) {
      state.events.splice(0, state.events.length - MAX_EVENTS_PER_SESSION);
    }
    const last = events[events.length - 1];
    if (last.ts > state.lastActivityAt) state.lastActivityAt = last.ts;
    // Earliest observed event is the best approximation of the session start
    // (replay only sees the transcript tail, so mtime-seeded value may be later).
    if (events[0].ts < state.startedAt) state.startedAt = events[0].ts;
  }

  /** Called when the transcript file receives an append (regardless of parse results). */
  markAppend(sessionId: string, whenMs: number): void {
    const state = this.sessions.get(sessionId);
    if (state) state.lastAppendMs = Math.max(state.lastAppendMs, whenMs);
  }

  /**
   * Reclassify all sessions from a liveness sample.
   * running: appended recently (actively working)
   * waiting: a claude process is tied to this session (resumed id, or a fresh
   *          process whose cwd matches) but nothing is being appended
   * ended: no process tie and no recent activity
   */
  applyLivenessSample(sample: LivenessSample, nowMs = Date.now()): void {
    // A fresh process cwd can only vouch for one session: the most recently
    // active one in that directory (older sessions there are truly ended).
    const freshCwdClaims = new Map<string, SessionState>();
    for (const state of this.sessions.values()) {
      if (!state.cwd || !sample.freshProcessCwds.has(state.cwd)) continue;
      const current = freshCwdClaims.get(state.cwd);
      if (!current || state.lastAppendMs > current.lastAppendMs) {
        freshCwdClaims.set(state.cwd, state);
      }
    }

    for (const state of this.sessions.values()) {
      const activeRecently = nowMs - state.lastAppendMs < ACTIVE_MTIME_WINDOW_MS;
      const processTied =
        sample.resumedSessionIds.has(state.sessionId) || freshCwdClaims.get(state.cwd) === state;
      let next: SessionStatus;
      if (activeRecently) {
        next = 'running';
      } else if (processTied) {
        next = 'waiting';
      } else {
        next = 'ended';
      }
      if (next === 'waiting') {
        // heuristic: a pending tool_use at the tip usually means a permission
        // prompt; a finished assistant/user turn means it's the user's move
        state.waitingReason = state.lastMainEventKind === 'tool-start' ? 'permission' : 'user-turn';
      } else {
        state.waitingReason = undefined;
      }
      if (next !== state.status) {
        state.status = next;
        this.listeners.onStatusChange(state.sessionId, next, state.lastActivityAt, state.waitingReason);
      }
    }
  }

  /**
   * Drop sessions with no activity inside the window and no live process tie.
   * Returns evicted session ids so the ingestion layer can release tail state.
   */
  evictSessionsOlderThan(windowMs: number, nowMs = Date.now()): string[] {
    const evicted: string[] = [];
    for (const [sessionId, state] of this.sessions) {
      if (state.status !== 'ended') continue;
      if (nowMs - state.lastAppendMs > windowMs) {
        this.sessions.delete(sessionId);
        evicted.push(sessionId);
      }
    }
    return evicted;
  }

  /** Lookup for the jump-to-session launcher. */
  getJumpTarget(
    sessionId: string,
  ): { sessionId: string; entrypoint: string; cwd: string; status: SessionStatus } | null {
    const state = this.sessions.get(sessionId);
    return state
      ? { sessionId, entrypoint: state.entrypoint, cwd: state.cwd, status: state.status }
      : null;
  }

  snapshotAll(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.lastAppendMs - a.lastAppendMs)
      .map((s) => this.toSnapshot(s));
  }

  private toSnapshot(state: SessionState): SessionSnapshot {
    const { lastAppendMs, lastMainEventKind, ...rest } = state;
    return { ...rest, events: [...state.events] };
  }
}
