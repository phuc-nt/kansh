// Top-level dashboard: shared header (stats, filters, view toggle, connection
// banner), body switches between the card grid and the global timeline.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedEvent } from '../../shared/normalized-event-types';
import type { GraphStoreState } from '../session-graph-store';
import { SessionLaneCard } from './session-lane-card';
import { SessionFilterBar, type SessionFilters } from './session-filter-bar';
import { EventDetailSidePanel } from './event-detail-side-panel';
import { ViewModeToggle, type ViewMode } from './view-mode-toggle';
import { GlobalTimelineView } from './global-timeline-view';
import { DailyDigestStrip } from './daily-digest-strip';

const VIEW_MODE_KEY = 'kansh-view-mode';

export function DashboardGrid({ state }: { state: GraphStoreState }) {
  const [filters, setFilters] = useState<SessionFilters>({ hideEnded: false, project: '' });
  const [selected, setSelected] = useState<NormalizedEvent | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_MODE_KEY) === 'timeline' ? 'timeline' : 'cards'),
  );
  // session to scroll into view after a timeline -> cards jump
  const jumpTarget = useRef<string | null>(null);

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_KEY, mode);
  };

  const jumpToSession = (sessionId: string) => {
    jumpTarget.current = sessionId;
    changeViewMode('cards');
  };

  useEffect(() => {
    if (viewMode !== 'cards' || !jumpTarget.current) return;
    document
      .querySelector(`[data-session-id="${jumpTarget.current}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    jumpTarget.current = null;
  }, [viewMode]);

  const projects = useMemo(
    () => [...new Set(state.sessions.map((s) => s.cwd || s.project))].sort(),
    [state.sessions],
  );

  const visible = state.sessions.filter(
    (s) =>
      (!filters.hideEnded || s.status !== 'ended') &&
      (!filters.project || (s.cwd || s.project) === filters.project),
  );
  const liveCount = state.sessions.filter((s) => s.status !== 'ended').length;
  const waitingCount = state.sessions.filter((s) => s.status === 'waiting').length;

  // surface waiting sessions in the tab title so it's visible from any window
  useEffect(() => {
    document.title = waitingCount > 0 ? `(${waitingCount} waiting) kansh` : 'kansh';
  }, [waitingCount]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>kansh</h1>
        <ViewModeToggle mode={viewMode} onChange={changeViewMode} />
        <span className="header-stats">
          {liveCount} live · {state.sessions.length - liveCount} recent
          {waitingCount > 0 ? ` · ⏸ ${waitingCount} waiting for you` : ''}
        </span>
        <SessionFilterBar filters={filters} projects={projects} onChange={setFilters} />
        {state.connection === 'open' ? null : (
          <span className="connection-banner">
            {state.connection === 'connecting' ? 'connecting…' : 'reconnecting…'}
          </span>
        )}
      </header>
      <DailyDigestStrip sessions={state.sessions} />
      {viewMode === 'timeline' ? (
        <GlobalTimelineView sessions={visible} onJumpToSession={jumpToSession} />
      ) : visible.length === 0 ? (
        <p className="empty-state">No Claude Code sessions match.</p>
      ) : (
        <div className="card-grid">
          {/* DOM order stays stable (keyed by sessionId, rendered in id order);
              visual ranking uses CSS `order`. Moving a DOM node would reset
              its viewport scrollTop and silently break auto-follow. */}
          {[...visible]
            .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
            .map((s) => (
              <div
                key={s.sessionId}
                data-session-id={s.sessionId}
                style={{ order: visible.findIndex((v) => v.sessionId === s.sessionId) }}
              >
                <SessionLaneCard session={s} onSelectEvent={setSelected} />
              </div>
            ))}
        </div>
      )}
      {selected ? <EventDetailSidePanel event={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
