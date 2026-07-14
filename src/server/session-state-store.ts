// In-memory session state: applies normalized events, tracks metadata and
// liveness status, and serializes snapshots for newly connected UI clients.
// Long-running daemon: sessions past the history window are evicted (see
// evictSessionsOlderThan), keeping memory bounded.

import type {
  FileConflict,
  FileTouch,
  NormalizedEvent,
  SessionSnapshot,
  SessionStatus,
  TodoItem,
  WorkflowTimeline,
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
  totalTokensCacheRead: number;
  contextTokens: number;
  waitingReason?: 'permission' | 'user-turn';
  /** kind of the most recent main-lane event, drives waitingReason */
  lastMainEventKind?: NormalizedEvent['kind'];
  // --- semantic layer (main lane only, except errors/loop which span lanes) ---
  mission?: string;
  todos?: TodoItem[];
  pendingQuestion?: string;
  /** toolUseId of the in-flight AskUserQuestion, to clear on its tool-end */
  pendingQuestionToolUseId?: string;
  errorStreak: number;
  loopSuspect?: string;
  /** signature that set loopSuspect — clearing must count THIS, not the latest event's */
  loopSuspectSignature?: string;
  /** ring of recent tool signatures for loop detection */
  recentToolSignatures: string[];
  /** last broadcast semantics fingerprint (change detection) */
  lastSemanticsKey?: string;
  // --- provenance layer ---
  /** Claude Code's generated title (latest wins) */
  aiTitle?: string;
  /** user-set title (latest wins, beats aiTitle) */
  customTitle?: string;
  /** path → activity counters, capped at MAX_FILES_TOUCHED */
  filesTouched: Map<string, FileTouch>;
  conflicts?: FileConflict[];
  currentSkill?: string;
  /** main-lane tool-starts without a skill remaining before currentSkill expires */
  skillTtl: number;
  blockedCount: number;
  /** whole-session workflow trace (server-scanned, not from the event window) */
  workflow?: WorkflowTimeline;
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
  onSemanticsChange: (
    sessionId: string,
    semantics: {
      mission?: string;
      todos?: TodoItem[];
      pendingQuestion?: string;
      errorStreak: number;
      loopSuspect?: string;
      title?: string;
      filesTouched?: FileTouch[];
      conflicts?: FileConflict[];
      currentSkill?: string;
      blockedCount: number;
      workflow?: WorkflowTimeline;
    },
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
      totalTokensCacheRead: 0,
      contextTokens: 0,
      errorStreak: 0,
      recentToolSignatures: [],
      filesTouched: new Map(),
      skillTtl: 0,
      blockedCount: 0,
    };
    this.sessions.set(sessionId, state);
    if (!quiet) this.listeners.onSessionAdded(this.toSnapshot(state));
  }

  /** Merge metadata fields scraped from transcript records (first-wins; titles latest-wins). */
  applyMeta(sessionId: string, meta: SessionMetaFields, quiet = false): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (meta.cwd && !state.cwd) state.cwd = meta.cwd;
    if (meta.slug && !state.slug) state.slug = meta.slug;
    if (meta.entrypoint && !state.entrypoint) state.entrypoint = meta.entrypoint;
    // titles are re-generated over a session's life — the newest one wins.
    // Title records carry no events, so broadcast from here or they'd wait
    // for the next unrelated event to surface.
    if (meta.aiTitle) state.aiTitle = meta.aiTitle;
    if (meta.customTitle) state.customTitle = meta.customTitle;
    if (meta.aiTitle || meta.customTitle) this.emitSemanticsIfChanged(state, quiet);
  }

  /** Attach the whole-session workflow trace (server-scanned); broadcast on change. */
  applyWorkflow(sessionId: string, workflow: WorkflowTimeline | undefined, quiet = false): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.workflow = workflow;
    this.emitSemanticsIfChanged(state, quiet);
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
        state.totalTokensCacheRead += event.usage.cacheRead;
        if (event.agentId === null) {
          // context size ≈ everything the latest main turn read:
          // fresh input + cache hits + cache being written this turn
          state.contextTokens = event.usage.in + event.usage.cacheRead + event.usage.cacheCreation;
        }
      }
      if (event.model && event.agentId === null) state.model = event.model;
      if (event.agentId === null) state.lastMainEventKind = event.kind;
      this.applySemantics(state, event, quiet);
      if (!quiet) this.listeners.onEvent(event);
    }
    this.emitSemanticsIfChanged(state, quiet);
    if (state.events.length > MAX_EVENTS_PER_SESSION) {
      state.events.splice(0, state.events.length - MAX_EVENTS_PER_SESSION);
    }
    const last = events[events.length - 1];
    if (last.ts > state.lastActivityAt) state.lastActivityAt = last.ts;
    // Earliest observed event is the best approximation of the session start
    // (replay only sees the transcript tail, so mtime-seeded value may be later).
    if (events[0].ts < state.startedAt) state.startedAt = events[0].ts;
  }

  /** consecutive tool signatures within this window flag a possible loop */
  private static readonly LOOP_RING = 15;
  private static readonly LOOP_MIN_REPEATS = 3;
  /** unattributed main-lane tool-starts before currentSkill expires */
  private static readonly SKILL_TTL = 10;
  /** per-session cap on tracked file paths */
  private static readonly MAX_FILES_TOUCHED = 50;
  /** edits by two live sessions within this window of now = conflict */
  private static readonly CONFLICT_WINDOW_MS = 30 * 60_000;

  /** cross-session edit index: path → sessionId → last edit epoch ms */
  private editIndex = new Map<string, Map<string, number>>();

  /**
   * Record an edit in the cross-session index. Immediate recompute only for
   * live multi-writer paths — quiet startup replay must not broadcast, and the
   * periodic liveness sample recomputes within seconds anyway.
   */
  private noteEdit(path: string, sessionId: string, ms: number, quiet: boolean): void {
    let byPath = this.editIndex.get(path);
    if (!byPath) this.editIndex.set(path, (byPath = new Map()));
    byPath.set(sessionId, Math.max(byPath.get(sessionId) ?? 0, ms));
    if (!quiet && byPath.size >= 2) this.recomputeConflicts();
  }

  /**
   * Rebuild conflicts for all sessions: a path counts when ≥2 LIVE sessions
   * edited it within the recent window. Sessions whose conflict list changed
   * get a semantics broadcast. Entries older than the window are pruned here
   * (they can never conflict again; a re-edit re-inserts), keeping the index
   * bounded by recently-edited paths even on multi-day uptime.
   */
  recomputeConflicts(nowMs = Date.now()): void {
    const fresh = new Map<string, FileConflict[]>();
    for (const [path, byPath] of this.editIndex) {
      const liveRecent: string[] = [];
      for (const [sessionId, ms] of byPath) {
        const session = this.sessions.get(sessionId);
        if (!session || nowMs - ms > SessionStateStore.CONFLICT_WINDOW_MS) {
          byPath.delete(sessionId); // evicted session or stale edit — prune
          continue;
        }
        if (session.status !== 'ended') liveRecent.push(sessionId);
      }
      if (byPath.size === 0) {
        this.editIndex.delete(path);
        continue;
      }
      if (liveRecent.length < 2) continue;
      for (const sessionId of liveRecent) {
        const others = liveRecent.filter((id) => id !== sessionId);
        let list = fresh.get(sessionId);
        if (!list) fresh.set(sessionId, (list = []));
        list.push({ path, otherSessionIds: others });
      }
    }
    for (const state of this.sessions.values()) {
      const next = fresh.get(state.sessionId);
      const changed =
        JSON.stringify(next ?? null) !== JSON.stringify(state.conflicts ?? null);
      if (changed) {
        state.conflicts = next;
        this.emitSemanticsIfChanged(state, false);
      }
    }
  }

  /** Semantic-layer rules; see contract docs for field meanings. */
  private applySemantics(state: SessionState, event: NormalizedEvent, quiet = false): void {
    const isMain = event.agentId === null;

    // mission: latest real user prompt (noise already filtered by the parser).
    // A new user message also moots any question that was awaiting an answer —
    // interrupts don't always produce a tool_result to clear it.
    if (isMain && event.kind === 'user-message' && event.label) {
      state.mission = event.label;
      state.pendingQuestion = undefined;
      state.pendingQuestionToolUseId = undefined;
    }

    // todo list: latest main-lane TodoWrite wins (subagents keep their own)
    if (isMain && event.todos) state.todos = event.todos;

    // pending question: set on AskUserQuestion start, cleared by its tool-end
    if (isMain && event.question && event.toolUseId) {
      state.pendingQuestion = event.question;
      state.pendingQuestionToolUseId = event.toolUseId;
    }
    if (
      event.kind === 'tool-end' &&
      event.toolUseId &&
      event.toolUseId === state.pendingQuestionToolUseId
    ) {
      state.pendingQuestion = undefined;
      state.pendingQuestionToolUseId = undefined;
    }

    // error streak: consecutive error results at the tip (any lane)
    if (event.kind === 'tool-end') {
      state.errorStreak = event.isError ? state.errorStreak + 1 : 0;
    }

    // loop suspicion: same (tool + label) recurring in the recent window.
    // The clear decision counts the SUSPECT's signature — counting the
    // incoming event's would clear the badge on the first unrelated tool.
    if (event.kind === 'tool-start' && event.toolName) {
      const signature = `${event.toolName}:${event.label ?? ''}`;
      state.recentToolSignatures.push(signature);
      if (state.recentToolSignatures.length > SessionStateStore.LOOP_RING) {
        state.recentToolSignatures.shift();
      }
      const repeats = state.recentToolSignatures.filter((s) => s === signature).length;
      if (repeats >= SessionStateStore.LOOP_MIN_REPEATS) {
        state.loopSuspect = event.toolName + (event.label ? ` ${event.label.slice(0, 40)}` : '');
        state.loopSuspectSignature = signature;
      } else if (state.loopSuspectSignature) {
        const suspectRepeats = state.recentToolSignatures.filter(
          (s) => s === state.loopSuspectSignature,
        ).length;
        if (suspectRepeats <= 1) {
          state.loopSuspect = undefined; // suspect rotated out of the window
          state.loopSuspectSignature = undefined;
        }
      }
    }

    // current skill: latest attributed main-lane tool; expires after a run of
    // unattributed tools so a stale badge doesn't outlive the skill
    if (isMain && event.kind === 'tool-start') {
      if (event.skill) {
        state.currentSkill = event.skill;
        state.skillTtl = SessionStateStore.SKILL_TTL;
      } else if (state.currentSkill && --state.skillTtl <= 0) {
        state.currentSkill = undefined;
      }
    }

    // friction: blocked tools (permission denials, hook preventions).
    // Session-wide by design (any lane) — timeline markers are main-lane only,
    // so the badge can legitimately exceed visible markers.
    if (event.blocked) state.blockedCount += 1;

    // file activity: aggregate per path, capped
    if (event.fileTouch) this.applyFileTouch(state, event.fileTouch, event.ts, quiet);
  }

  private applyFileTouch(
    state: SessionState,
    touch: { path: string; action: 'edit' | 'read' },
    ts: string,
    quiet: boolean,
  ): void {
    let entry = state.filesTouched.get(touch.path);
    if (!entry) {
      if (state.filesTouched.size >= SessionStateStore.MAX_FILES_TOUCHED) {
        // evict the least-active path to stay bounded
        let coldest: string | undefined;
        let coldestScore = Infinity;
        for (const [path, ft] of state.filesTouched) {
          const score = ft.edits + ft.reads;
          if (score < coldestScore) {
            coldestScore = score;
            coldest = path;
          }
        }
        if (coldest !== undefined) state.filesTouched.delete(coldest);
      }
      entry = { path: touch.path, edits: 0, reads: 0 };
      state.filesTouched.set(touch.path, entry);
    }
    if (touch.action === 'edit') {
      entry.edits += 1;
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms)) {
        entry.lastEditMs = Math.max(entry.lastEditMs ?? 0, ms);
        this.noteEdit(touch.path, state.sessionId, entry.lastEditMs, quiet);
      }
    } else {
      entry.reads += 1;
    }
  }

  /** Broadcast semantics only when the fingerprint actually changed. */
  private emitSemanticsIfChanged(state: SessionState, quiet: boolean): void {
    const key = [
      state.mission,
      state.pendingQuestion,
      state.errorStreak,
      state.loopSuspect,
      state.todos?.map((t) => `${t.status}${t.content}`).join('\u0000'),
      state.customTitle ?? state.aiTitle,
      state.currentSkill,
      state.blockedCount,
      [...state.filesTouched.values()].map((ft) => `${ft.path}:${ft.edits}.${ft.reads}`).join(','),
      JSON.stringify(state.conflicts ?? null),
      // workflow: cheap signature = phase count + last skill + spawn count
      state.workflow ? `${state.workflow.phases.length}:${state.workflow.phases.at(-1)?.skill}:${state.workflow.spawns.length}` : '',
    ].join('\u0000');
    if (key === state.lastSemanticsKey) return;
    state.lastSemanticsKey = key;
    if (quiet) return;
    this.listeners.onSemanticsChange(state.sessionId, {
      mission: state.mission,
      todos: state.todos,
      pendingQuestion: state.pendingQuestion,
      errorStreak: state.errorStreak,
      loopSuspect: state.loopSuspect,
      title: state.customTitle ?? state.aiTitle,
      filesTouched: this.filesTouchedList(state),
      conflicts: state.conflicts,
      currentSkill: state.currentSkill,
      blockedCount: state.blockedCount,
      workflow: state.workflow,
    });
  }

  /** filesTouched map to capped array sorted by activity (hottest first). */
  private filesTouchedList(state: SessionState): FileTouch[] | undefined {
    if (state.filesTouched.size === 0) return undefined;
    return [...state.filesTouched.values()]
      .sort((a, b) => b.edits + b.reads - (a.edits + a.reads))
      .map((ft) => ({ ...ft }));
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
        // a skill badge should not outlive the work: clear once nothing runs
        if (next !== 'running') {
          state.currentSkill = undefined;
          state.skillTtl = 0;
        }
        state.status = next;
        this.listeners.onStatusChange(state.sessionId, next, state.lastActivityAt, state.waitingReason);
      }
    }
    // liveness changes conflict eligibility (live-only) and time moves the
    // 30min window, so refresh alongside each sample
    this.recomputeConflicts(nowMs);
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
    const {
      lastAppendMs,
      lastMainEventKind,
      pendingQuestionToolUseId,
      loopSuspectSignature,
      recentToolSignatures,
      lastSemanticsKey,
      aiTitle,
      customTitle,
      filesTouched,
      skillTtl,
      ...rest
    } = state;
    return {
      ...rest,
      title: customTitle ?? aiTitle,
      filesTouched: this.filesTouchedList(state),
      events: [...state.events],
    };
  }
}
