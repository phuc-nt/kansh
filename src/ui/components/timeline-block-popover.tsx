// In-place inspection of one activity block: time range, tokens, tool mix,
// the events inside the range, and a jump-to-card escape hatch. Anchored near
// the click point; parent owns open/close state.

import { memo, useMemo } from 'react';
import type { NormalizedEvent, SessionSnapshot } from '../../shared/normalized-event-types';
import type { ActivityBlock, TimelineLane } from '../timeline-layout-engine';
import { eventColor, eventLabel } from './tool-node-glyph';

const MAX_EVENTS = 15;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export const TimelineBlockPopover = memo(function TimelineBlockPopover({
  lane,
  block,
  session,
  x,
  y,
  onClose,
  onOpenCard,
}: {
  lane: TimelineLane;
  block: ActivityBlock;
  session: SessionSnapshot | undefined;
  x: number;
  y: number;
  onClose: () => void;
  onOpenCard: (sessionId: string) => void;
}) {
  // events inside the block's time range, resolved at open time
  const events: NormalizedEvent[] = useMemo(() => {
    if (!session) return [];
    const inRange = session.events.filter((e) => {
      const ms = Date.parse(e.ts);
      return !Number.isNaN(ms) && ms >= block.startMs && ms <= block.endMs;
    });
    return inRange.slice(-MAX_EVENTS);
  }, [session, block]);

  return (
    <div
      className="timeline-popover"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 380)),
        top: Math.max(8, Math.min(y + 12, window.innerHeight - 320)),
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="popover-header">
        <strong>{lane.label}</strong> · {fmtTime(block.startMs)}–{fmtTime(block.endMs)}
        <button className="detail-close" onClick={onClose} aria-label="đóng">✕</button>
      </div>
      <div className="popover-meta">
        {block.eventCount} events
        {block.dominantTools.length > 0 ? ` · ${block.dominantTools.join(', ')}` : ''}
        {block.tokensIn + block.tokensOut > 0
          ? ` · ▲${fmtTokens(block.tokensIn)} ▼${fmtTokens(block.tokensOut)}`
          : ''}
      </div>
      <ul className="popover-events">
        {events.map((e) => (
          <li key={e.uuid} style={{ color: eventColor(e) }}>
            {fmtTime(Date.parse(e.ts))} {eventLabel(e) || e.kind}
          </li>
        ))}
        {events.length === 0 ? <li className="popover-empty">events ngoài cửa sổ giữ lại của client</li> : null}
      </ul>
      <button
        className="popover-open-card"
        onClick={() => {
          onClose();
          onOpenCard(lane.sessionId);
        }}
      >
        mở card →
      </button>
    </div>
  );
});
