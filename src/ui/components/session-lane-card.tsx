// One session card: header (project, slug, status) + scrollable graph viewport
// with auto-follow (sticks to bottom unless the user scrolled up).

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedEvent, SessionSnapshot } from '../../shared/normalized-event-types';
import { contextLimitForModel, shortModelName } from '../../shared/model-context-limits';
import { GitGraphSvg } from './git-graph-svg';
import { ActivitySparkline } from './activity-sparkline';
import { SessionSemanticSummary } from './session-semantic-summary';
import { SessionFileActivity } from './session-file-activity';
import { SessionWorkflowMap } from './session-workflow-map';
import { sessionLabel, sessionSubtitle } from '../session-label';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Context-fill gauge: approximate % of the model's window in use. */
function ContextGauge({ contextTokens, model }: { contextTokens: number; model: string }) {
  if (contextTokens <= 0) return null;
  const pct = Math.min(100, Math.round((contextTokens / contextLimitForModel(model, contextTokens)) * 100));
  const level = pct > 85 ? 'high' : pct > 70 ? 'mid' : 'low';
  return (
    <span className="context-gauge" title={`~${pct}% context (${formatTokens(contextTokens)} tokens)`}>
      <span className={`context-gauge-fill gauge-${level}`} style={{ width: `${pct}%` }} />
      <span className="context-gauge-text">~{pct}%</span>
    </span>
  );
}

const FOLLOW_THRESHOLD_PX = 40;

function relativeTime(iso: string): string {
  const diffSec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

export const SessionLaneCard = memo(function SessionLaneCard({
  session,
  onSelectEvent,
}: {
  session: SessionSnapshot;
  onSelectEvent?: (event: NormalizedEvent) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  // ended sessions start collapsed (header only); click header to expand
  const [collapsed, setCollapsed] = useState(session.status === 'ended');
  const [toast, setToast] = useState<string | null>(null);
  // semantic-first: the git-graph lives behind an expander, remembered per session
  const graphOpenKey = `kansh-graph-open:${session.sessionId}`;
  const [graphOpen, setGraphOpen] = useState(() => localStorage.getItem(graphOpenKey) === '1');
  const toggleGraph = () => {
    setGraphOpen((open) => {
      localStorage.setItem(graphOpenKey, open ? '0' : '1');
      return !open;
    });
  };
  // minute ticker: waiting-duration text only needs minute granularity
  const [nowMinuteMs, setNowMinuteMs] = useState(() => Date.now());
  useEffect(() => {
    if (session.status !== 'waiting') return;
    const timer = setInterval(() => setNowMinuteMs(Date.now()), 60_000);
    setNowMinuteMs(Date.now());
    return () => clearInterval(timer);
  }, [session.status]);
  // condensed segments the user expanded back into full nodes
  const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
  const toggleSegment = (uuid: string) =>
    setExpandedSegments((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });

  // keep collapse in sync with status transitions (a card can mount before the
  // first liveness sample classifies it, or an ended session can resume)
  const wasEnded = useRef(session.status === 'ended');
  useEffect(() => {
    const isEnded = session.status === 'ended';
    if (isEnded !== wasEnded.current) {
      wasEnded.current = isEnded;
      setCollapsed(isEnded);
    }
  }, [session.status]);

  const jump = async (e: React.MouseEvent) => {
    e.stopPropagation(); // don't toggle collapse
    try {
      const res = await fetch('/api/jump', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      const result = (await res.json()) as { action?: string; resumeCommand?: string };
      if (result.action === 'copy-fallback' && result.resumeCommand) {
        await navigator.clipboard.writeText(result.resumeCommand).catch(() => {});
        setToast('resume command copied');
      } else if (result.action === 'opened-vscode') {
        setToast('opened in VSCode');
      } else if (result.action === 'activated-terminal') {
        setToast('terminal activated');
      } else {
        setToast('jump failed');
      }
    } catch {
      setToast('jump failed');
    }
    setTimeout(() => setToast(null), 2500);
  };

  // auto-follow newest activity while the user hasn't scrolled up.
  // Depend on array identity, not length: once the event cap is reached the
  // length stays constant while content keeps changing.
  // useLayoutEffect + synchronous read: runs right after DOM commit (reading
  // scrollHeight forces layout), and unlike requestAnimationFrame it also
  // fires in backgrounded/occluded tabs — where a monitor lives most of the
  // time — and in headless verification runs.
  // remembers where WE put the scrollbar, to tell our scrolls from the user's
  const programmaticTop = useRef(0);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el && following) {
      el.scrollTop = el.scrollHeight;
      programmaticTop.current = el.scrollTop;
    }
  }, [session.events, following, collapsed, graphOpen]);

  // Pending tools drive the live elapsed ticker: re-render this card each
  // second ONLY while at least one tool-start lacks its tool-end.
  const pendingToolUuids = useMemo(() => {
    const ended = new Set(
      session.events.filter((e) => e.kind === 'tool-end' && e.toolUseId).map((e) => e.toolUseId),
    );
    return new Set(
      session.events
        .filter((e) => e.kind === 'tool-start' && e.toolUseId && !ended.has(e.toolUseId))
        .map((e) => e.uuid),
    );
  }, [session.events]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (pendingToolUuids.size === 0 || session.status === 'ended') return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [pendingToolUuids.size, session.status]);

  // Unfollow paths must cover every input: wheel (upward intent, read from
  // deltaY because the wheel event fires BEFORE the position updates), touch,
  // and scrollbar-drag/keyboard (detected in onScroll as an upward move we
  // didn't make ourselves — programmatic scrolls are recorded above).
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) setFollowing(false);
  };
  const onTouchMove = () => {
    const el = viewportRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight >= FOLLOW_THRESHOLD_PX) {
      setFollowing(false);
    }
  };
  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
    if (atBottom) {
      if (!following) setFollowing(true);
      programmaticTop.current = el.scrollTop;
    } else if (following && el.scrollTop < programmaticTop.current - 2) {
      // moved up and it wasn't us → scrollbar drag or keyboard
      setFollowing(false);
    }
  };

  return (
    <div className={`session-card status-${session.status}`}>
      <div className="session-header" onClick={() => setCollapsed((c) => !c)}>
        <span className={`status-dot status-dot-${session.status}`} />
        <span className="session-project" title={session.title}>{sessionLabel(session)}</span>
        <span className="session-slug">{sessionSubtitle(session) ?? (session.slug || session.sessionId.slice(0, 8))}</span>
        {session.currentSkill ? (
          <span className="skill-badge" title="skill được ghi nhận cho các tool gần nhất">
            ⚙ {session.currentSkill}
          </span>
        ) : null}
        {session.model ? <span className="model-badge">{shortModelName(session.model)}</span> : null}
        {session.totalTokensIn + session.totalTokensOut > 0 ? (
          <span
            className="token-stats"
            title={`in ${formatTokens(session.totalTokensIn)} / out ${formatTokens(session.totalTokensOut)} (observed window)`}
          >
            ▲{formatTokens(session.totalTokensIn)} ▼{formatTokens(session.totalTokensOut)}
          </span>
        ) : null}
        <ContextGauge contextTokens={session.contextTokens} model={session.model} />
        <ActivitySparkline events={session.events} />
        <span className="session-meta">
          {session.status === 'waiting'
            ? session.waitingReason === 'permission'
              ? '⏸ chờ permission?'
              : '⏸ chờ bạn trả lời'
            : session.status}
          {' · '}
          {relativeTime(session.lastActivityAt)}
        </span>
        <button className="jump-button" onClick={jump} title="focus this session's window">
          ↗
        </button>
      </div>
      {toast ? <div className="jump-toast">{toast}</div> : null}
      {session.conflicts?.length ? (
        <div className="conflict-banner" title={session.conflicts.map((c) => c.path).join('\n')}>
          ⚠ trùng file với session khác: {session.conflicts[0].path.split('/').pop()}
          {session.conflicts.length > 1 ? ` +${session.conflicts.length - 1}` : ''}
          {session.conflicts[0].otherSessionIds.map((id) => (
            <button
              key={id}
              className="conflict-jump"
              onClick={(e) => {
                e.stopPropagation();
                document
                  .querySelector(`[data-session-id="${id}"]`)
                  ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }}
            >
              → {id.slice(0, 8)}
            </button>
          ))}
        </div>
      ) : null}
      {collapsed ? null : (
        <>
          <SessionSemanticSummary session={session} nowMinuteMs={nowMinuteMs} />
          <SessionWorkflowMap session={session} />
          {session.filesTouched?.length ? (
            <SessionFileActivity
              filesTouched={session.filesTouched}
              cwd={session.cwd}
              sessionId={session.sessionId}
            />
          ) : null}
          <button className="graph-expander" onClick={toggleGraph}>
            {graphOpen ? '▴ ẩn graph chi tiết' : '▾ xem graph chi tiết'}
          </button>
          {graphOpen ? (
            <>
              <div
                className="graph-viewport"
                ref={viewportRef}
                onScroll={onScroll}
                onWheel={onWheel}
                onTouchMove={onTouchMove}
              >
                <GitGraphSvg
                  events={session.events}
                  status={session.status}
                  onSelectEvent={onSelectEvent}
                  expandedSegments={expandedSegments}
                  onToggleSegment={toggleSegment}
                  pendingToolUuids={pendingToolUuids}
                  renderTick={tick}
                />
              </div>
              {following ? null : (
                <button className="jump-latest" onClick={() => setFollowing(true)}>
                  ↓ latest
                </button>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  );
});
