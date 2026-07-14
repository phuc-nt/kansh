// Shared contract between server (producer) and UI (consumer).
// Phase 2 UI renders lanes/branches purely from these types.

export type EventKind =
  | 'session-start'
  | 'user-message'
  | 'assistant-message'
  | 'tool-start'
  | 'tool-end'
  | 'subagent-spawn'
  | 'subagent-end'
  | 'session-end';

export interface NormalizedEvent {
  sessionId: string;
  /** null = main agent lane; otherwise the subagent branch this event belongs to */
  agentId: string | null;
  /** ISO timestamp */
  ts: string;
  /**
   * Server-assigned monotonic sequence (apply order, not chronological order —
   * startup replay may apply lanes out of time order). Renderers must sort by
   * (ts, seq): ts for chronology, seq as a deterministic tiebreaker.
   */
  seq: number;
  kind: EventKind;
  /** unique id for the event (record uuid or synthesized) */
  uuid: string;
  toolName?: string;
  /** links subagent-spawn to the parent tool_use that spawned it */
  toolUseId?: string;
  /** subagent type from meta.json (e.g. "code-reviewer") */
  agentType?: string;
  /** nesting level from meta.json (1 = spawned by main agent) */
  spawnDepth?: number;
  /** short human-readable text: truncated prompt, tool target, description */
  label?: string;
  /** token usage of the assistant turn this event came from (assistant records only) */
  usage?: { in: number; out: number; cacheRead: number; cacheCreation: number };
  /** model that produced this assistant turn */
  model?: string;
  /** tool_result reported is_error (tool-end only) */
  isError?: boolean;
  /** TodoWrite tool-start only: the task list being written */
  todos?: TodoItem[];
  /** AskUserQuestion tool-start only: first question's text */
  question?: string;
  /** skill this tool call was attributed to (record.attributionSkill) */
  skill?: string;
  /** the tool was blocked (permission denial or hook prevention) */
  blocked?: { kind: string; reason?: string };
  /** file this tool touched (from toolUseResult; edit = write tools, read = Read) */
  fileTouch?: { path: string; action: 'edit' | 'read' };
}

/** Per-session aggregate of file activity (capped). */
export interface FileTouch {
  path: string;
  edits: number;
  reads: number;
  /** epoch ms of the latest edit (undefined if only reads) */
  lastEditMs?: number;
}

/** Two live sessions edited the same file recently. */
export interface FileConflict {
  path: string;
  otherSessionIds: string[];
}

/**
 * Compact whole-session workflow trace, scanned server-side from the full
 * transcript (NOT the event window — a large session's replay tail holds no
 * main-lane skill records). Feeds the per-card workflow map.
 */
export interface WorkflowTimeline {
  /** main-lane skill phases in order (consecutive repeats already collapsed) */
  phases: { skill: string; ts: string }[];
  /** subagent spawns: type + when, to tie each to the phase active at spawn */
  spawns: { agentType: string; ts: string; depth: number }[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** present-tense label shown while in progress */
  activeForm?: string;
}

export type SessionStatus = 'running' | 'waiting' | 'ended';

export interface SessionSummary {
  sessionId: string;
  /** project directory slug under ~/.claude/projects */
  project: string;
  /** real working directory (from transcript records; more reliable than slug decoding) */
  cwd: string;
  /** human-friendly session slug from records (e.g. "flickering-spinning-allen") */
  slug: string;
  /** how the session was started, e.g. "claude-vscode" | "cli" (from records) */
  entrypoint: string;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  /** model of the latest assistant turn ('' until seen) */
  model: string;
  /** cumulative tokens across observed turns (tail-replay window only) */
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokensCacheRead: number;
  /** approximate current context size = latest main-lane turn's input + cacheRead */
  contextTokens: number;
  /** why a waiting session is waiting (heuristic) */
  waitingReason?: 'permission' | 'user-turn';
  /** latest real user prompt on the main lane (the session's current task) */
  mission?: string;
  /** latest TodoWrite list from the main lane */
  todos?: TodoItem[];
  /** question currently awaiting the user's answer (AskUserQuestion in flight) */
  pendingQuestion?: string;
  /** consecutive error tool-results at the activity tip */
  errorStreak: number;
  /** repeated identical tool signature detected recently (possible stuck loop) */
  loopSuspect?: string;
  /** Claude Code's own session title (custom > ai-generated; undefined → fall back to project) */
  title?: string;
  /** files touched in the observed window, capped, sorted by activity */
  filesTouched?: FileTouch[];
  /** files also being edited by other LIVE sessions right now */
  conflicts?: FileConflict[];
  /** skill attributed to recent tool activity on the main lane */
  currentSkill?: string;
  /** count of blocked tools (permission denials / hook preventions) */
  blockedCount: number;
  /** whole-session MK workflow trace (phases + subagent spawns) for the card map */
  workflow?: WorkflowTimeline;
}

export interface SessionSnapshot extends SessionSummary {
  events: NormalizedEvent[];
}

/** Messages pushed from server to UI over WebSocket */
export type ServerMessage =
  | { type: 'snapshot'; sessions: SessionSnapshot[] }
  | { type: 'event'; event: NormalizedEvent }
  | {
      type: 'session-status';
      sessionId: string;
      status: SessionStatus;
      lastActivityAt: string;
      waitingReason?: 'permission' | 'user-turn';
    }
  | { type: 'session-added'; session: SessionSnapshot }
  | {
      type: 'session-semantics';
      sessionId: string;
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
    };
