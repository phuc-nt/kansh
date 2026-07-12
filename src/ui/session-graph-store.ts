// Client-side session store: hydrated by the snapshot, updated by incremental
// WS messages. Plain external store consumed via useSyncExternalStore.

import type {
  NormalizedEvent,
  ServerMessage,
  SessionSnapshot,
  SessionStatus,
} from '../shared/normalized-event-types';

/** Cap rendered/retained events per session on the client. */
const MAX_CLIENT_EVENTS = 600;

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface GraphStoreState {
  connection: ConnectionState;
  /** sorted by lastActivityAt desc for stable card order */
  sessions: SessionSnapshot[];
}

type Listener = () => void;

export class SessionGraphStore {
  private state: GraphStoreState = { connection: 'connecting', sessions: [] };
  private listeners = new Set<Listener>();
  /** uuid dedupe per session (reconnect snapshots overlap pushed events) */
  private seenUuids = new Map<string, Set<string>>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GraphStoreState => this.state;

  setConnection(connection: ConnectionState): void {
    this.commit({ ...this.state, connection });
  }

  applyServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.seenUuids = new Map(
          message.sessions.map((s) => [s.sessionId, new Set(s.events.map((e) => e.uuid))]),
        );
        this.commit({ ...this.state, sessions: sortSessions(message.sessions.map(capEvents)) });
        break;
      case 'session-added':
        if (this.state.sessions.some((s) => s.sessionId === message.session.sessionId)) break;
        this.seenUuids.set(message.session.sessionId, new Set(message.session.events.map((e) => e.uuid)));
        this.commit({
          ...this.state,
          sessions: sortSessions([...this.state.sessions, capEvents(message.session)]),
        });
        break;
      case 'event':
        this.applyEvent(message.event);
        break;
      case 'session-semantics':
        if (!this.state.sessions.some((s) => s.sessionId === message.sessionId)) break;
        this.commit({
          ...this.state,
          sessions: this.state.sessions.map((s) =>
            s.sessionId === message.sessionId
              ? {
                  ...s,
                  mission: message.mission,
                  todos: message.todos,
                  pendingQuestion: message.pendingQuestion,
                  errorStreak: message.errorStreak,
                  loopSuspect: message.loopSuspect,
                }
              : s,
          ),
        });
        break;
      case 'session-status':
        this.commit({
          ...this.state,
          sessions: sortSessions(
            this.state.sessions.map((s) =>
              s.sessionId === message.sessionId
                ? {
                    ...s,
                    status: message.status,
                    lastActivityAt: message.lastActivityAt,
                    waitingReason: message.waitingReason,
                  }
                : s,
            ),
          ),
        });
        break;
    }
  }

  private applyEvent(event: NormalizedEvent): void {
    // Unknown session (session-added lost mid-reconnect): drop without commit;
    // the next reconnect snapshot fully restores state.
    const session = this.state.sessions.find((s) => s.sessionId === event.sessionId);
    if (!session) return;
    const seen = this.seenUuids.get(event.sessionId);
    if (seen?.has(event.uuid)) return;
    seen?.add(event.uuid);
    this.commit({
      ...this.state,
      sessions: sortSessions(
        this.state.sessions.map((s) => {
          if (s.sessionId !== event.sessionId) return s;
          const next = capEvents({
            ...s,
            events: [...s.events, event],
            // replayed/older events must not move activity backwards
            lastActivityAt: event.ts > s.lastActivityAt ? event.ts : s.lastActivityAt,
          });
          // mirror the server's aggregation so header stats stay live
          if (event.usage) {
            next.totalTokensIn += event.usage.in;
            next.totalTokensOut += event.usage.out;
            next.totalTokensCacheRead += event.usage.cacheRead;
            if (event.agentId === null)
              next.contextTokens = event.usage.in + event.usage.cacheRead + event.usage.cacheCreation;
          }
          if (event.model && event.agentId === null) next.model = event.model;
          return next;
        }),
      ),
    });
  }

  private commit(next: GraphStoreState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

function capEvents(session: SessionSnapshot): SessionSnapshot {
  return session.events.length > MAX_CLIENT_EVENTS
    ? { ...session, events: session.events.slice(-MAX_CLIENT_EVENTS) }
    : session;
}

function sortSessions(sessions: SessionSnapshot[]): SessionSnapshot[] {
  const statusRank: Record<SessionStatus, number> = { running: 0, waiting: 1, ended: 2 };
  return [...sessions].sort(
    (a, b) => statusRank[a.status] - statusRank[b.status] || b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
}
