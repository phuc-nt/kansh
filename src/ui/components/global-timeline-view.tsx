// Global timeline: every session as a swimlane on one shared wall-clock axis.
// Owns the time window (span presets, live-pinned right edge, drag-pan) and
// the ms->px mapping; lane geometry comes from the pure timeline engine.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSnapshot } from '../../shared/normalized-event-types';
import { layoutTimeline } from '../timeline-layout-engine';
import { LANE_HEIGHT, TimelineLaneRow } from './timeline-lane-row';

/** virtual svg width; viewBox scales it to the container */
const VIEW_W = 1200;
const AXIS_H = 22;
const LABEL_W = 190;
const SPAN_PRESETS = [
  { label: '1h', ms: 3600_000 },
  { label: '3h', ms: 3 * 3600_000 },
  { label: '6h', ms: 6 * 3600_000 },
];
/** live mode advances the right edge on this cadence */
const LIVE_TICK_MS = 5000;

type WindowMode = { live: true } | { live: false; endMs: number };

function tickStepMs(spanMs: number): number {
  if (spanMs <= 3600_000) return 5 * 60_000;
  if (spanMs <= 3 * 3600_000) return 15 * 60_000;
  return 30 * 60_000;
}

function formatTick(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export const GlobalTimelineView = memo(function GlobalTimelineView({
  sessions,
  onJumpToSession,
}: {
  sessions: SessionSnapshot[];
  onJumpToSession: (sessionId: string) => void;
}) {
  const [spanMs, setSpanMs] = useState(SPAN_PRESETS[1].ms);
  const [mode, setMode] = useState<WindowMode>({ live: true });
  const [nowMs, setNowMs] = useState(() => Date.now());

  // "now" always advances (now-line + open spans stay honest even when the
  // window is unpinned); only the window's right edge depends on the mode
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const endMs = mode.live ? nowMs : mode.endMs;
  const window = useMemo(() => ({ startMs: endMs - spanMs, endMs }), [endMs, spanMs]);
  const lanes = useMemo(() => layoutTimeline(sessions, window, endMs), [sessions, window, endMs]);

  const msToX = (ms: number) => ((ms - window.startMs) / spanMs) * VIEW_W;

  // drag-pan: px delta -> ms delta; any pan unpins the live edge.
  // didDrag suppresses the click-to-jump that would otherwise fire on release.
  const dragState = useRef<{ startX: number; startEndMs: number; svgWidthPx: number } | null>(null);
  const didDrag = useRef(false);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    didDrag.current = false;
    dragState.current = {
      startX: e.clientX,
      startEndMs: endMs,
      svgWidthPx: e.currentTarget.getBoundingClientRect().width,
    };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    if (e.buttons === 0) {
      // pointercancel/lost-capture left stale state — stop phantom panning
      dragState.current = null;
      return;
    }
    const dxPx = e.clientX - drag.startX;
    if (Math.abs(dxPx) < 3) return; // click tolerance
    didDrag.current = true;
    const msPerPx = spanMs / drag.svgWidthPx;
    // never pan into the future — there is nothing there to show
    const panned = Math.min(drag.startEndMs - dxPx * msPerPx, Date.now());
    setMode({ live: false, endMs: panned });
  };
  const onPointerUp = () => {
    dragState.current = null;
  };
  const selectLane = (sessionId: string) => {
    if (!didDrag.current) onJumpToSession(sessionId);
  };

  const ticks = useMemo(() => {
    const step = tickStepMs(spanMs);
    const first = Math.ceil(window.startMs / step) * step;
    const result: number[] = [];
    for (let t = first; t <= window.endMs; t += step) result.push(t);
    return result;
  }, [window.startMs, window.endMs, spanMs]);

  const height = AXIS_H + Math.max(lanes.length, 1) * LANE_HEIGHT;
  const nowX = msToX(nowMs);

  return (
    <div className="timeline-view">
      <div className="timeline-controls">
        {SPAN_PRESETS.map((preset) => (
          <button
            key={preset.label}
            className={spanMs === preset.ms ? 'active' : ''}
            onClick={() => setSpanMs(preset.ms)}
          >
            {preset.label}
          </button>
        ))}
        {mode.live ? (
          <span className="live-indicator">● live</span>
        ) : (
          <button onClick={() => setMode({ live: true })}>⟳ now</button>
        )}
        <span className="timeline-hint">kéo để pan · click lane để mở card</span>
      </div>
      <div className="timeline-body">
        <div className="timeline-labels" style={{ paddingTop: AXIS_H }}>
          {lanes.map((lane) => (
            <div
              key={lane.sessionId}
              className={`timeline-label status-${lane.status}`}
              style={{ height: LANE_HEIGHT }}
              onClick={() => onJumpToSession(lane.sessionId)}
            >
              <span className={`status-dot status-dot-${lane.status}`} />
              <span className="timeline-label-text">{lane.label}</span>
              {lane.status === 'waiting' ? <span className="timeline-wait">⏸</span> : null}
            </div>
          ))}
          {lanes.length === 0 ? <div className="empty-state">no activity in window</div> : null}
        </div>
        <svg
          className="timeline-svg"
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="none"
          style={{ height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {ticks.map((t) => {
            const x = msToX(t);
            return (
              <g key={t}>
                <line x1={x} y1={AXIS_H} x2={x} y2={height} className="axis-gridline" />
                <text x={x + 3} y={14} className="axis-label">
                  {formatTick(t)}
                </text>
              </g>
            );
          })}
          <g transform={`translate(0, ${AXIS_H})`}>
            {lanes.map((lane, i) => (
              <TimelineLaneRow
                key={lane.sessionId}
                lane={lane}
                laneIndex={i}
                msToX={msToX}
                windowEndX={VIEW_W}
                onSelect={selectLane}
              />
            ))}
          </g>
          {nowX >= 0 && nowX <= VIEW_W ? (
            <line x1={nowX} y1={AXIS_H - 4} x2={nowX} y2={height} className="now-line" />
          ) : null}
        </svg>
      </div>
    </div>
  );
});
