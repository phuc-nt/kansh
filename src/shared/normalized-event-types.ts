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
    };
