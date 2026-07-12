// Global timeline: every session as a swimlane on one shared wall-clock axis.
// Owns the time window (span presets, live-pinned right edge, drag-pan) and
// the ms->px mapping; lane geometry comes from the pure timeline engine.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSnapshot } from '../../shared/normalized-event-types';
import { computeAttention, layoutTimeline, type ActivityBlock, type TimelineLane } from '../timeline-layout-engine';
import { LANE_HEIGHT, TimelineLaneRow, type BlockPointerHandlers } from './timeline-lane-row';
import { TimelineBlockPopover } from './timeline-block-popover';
import { TimelineAttentionRibbon } from './timeline-attention-ribbon';
import { laneColor } from '../lane-color-palette';

interface BlockAnchor {
  lane: TimelineLane;
  block: ActivityBlock;
  x: number;
  y: number;
}

function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

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
  // block inspection overlays: at most one tooltip and one popover at a time
  const [tooltip, setTooltip] = useState<BlockAnchor | null>(null);
  const [popover, setPopover] = useState<BlockAnchor | null>(null);
  // crosshair scrubber: time under the cursor, null when not hovering the svg
  const [scrubMs, setScrubMs] = useState<number | null>(null);

  // popover closes on outside click or Escape
  useEffect(() => {
    if (!popover) return;
    const onDown = () => setPopover(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popover]);

  // "now" always advances (now-line + open spans stay honest even when the
  // window is unpinned); only the window's right edge depends on the mode
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const endMs = mode.live ? nowMs : mode.endMs;
  const window = useMemo(() => ({ startMs: endMs - spanMs, endMs }), [endMs, spanMs]);
  const lanes = useMemo(() => layoutTimeline(sessions, window, endMs), [sessions, window, endMs]);
  const attention = useMemo(() => computeAttention(sessions, window), [sessions, window]);
  const laneIndexBySession = useMemo(
    () => new Map(lanes.map((lane, i) => [lane.sessionId, i])),
    [lanes],
  );
  const laneLabelBySession = useMemo(
    () => new Map(lanes.map((lane) => [lane.sessionId, lane.label])),
    [lanes],
  );

  // stable mapping fn so scrubber state changes don't re-render memo'd lane rows
  const msToX = useCallback(
    (ms: number) => ((ms - window.startMs) / spanMs) * VIEW_W,
    [window.startMs, spanMs],
  );

  // drag-pan: px delta -> ms delta; any pan unpins the live edge.
  // didDrag suppresses the click-to-jump that would otherwise fire on release.
  const dragState = useRef<{ startX: number; startEndMs: number; svgWidthPx: number } | null>(null);
  const didDrag = useRef(false);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    didDrag.current = false;
    setTooltip(null); // pan gesture starting — overlay would trail the wrong spot
    dragState.current = {
      startX: e.clientX,
      startEndMs: endMs,
      svgWidthPx: e.currentTarget.getBoundingClientRect().width,
    };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragState.current;
    if (!drag) {
      // plain hover: drive the crosshair scrubber (suppressed while inspecting)
      if (popover === null) {
        const rect = e.currentTarget.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        setScrubMs(window.startMs + frac * spanMs);
      }
      return;
    }
    if (e.buttons === 0) {
      // pointercancel/lost-capture left stale state — stop phantom panning
      dragState.current = null;
      return;
    }
    const dxPx = e.clientX - drag.startX;
    if (Math.abs(dxPx) < 3) return; // click tolerance
    if (!didDrag.current) {
      // capture only once a real pan starts; capturing on pointerdown would
      // retarget the click away from block rects and kill the popover
      e.currentTarget.setPointerCapture(e.pointerId);
      setScrubMs(null); // panning — crosshair would fight the moving window
    }
    didDrag.current = true;
    const msPerPx = spanMs / drag.svgWidthPx;
    // never pan into the future — there is nothing there to show
    const panned = Math.min(drag.startEndMs - dxPx * msPerPx, Date.now());
    setMode({ live: false, endMs: panned });
  };
  const onPointerUp = () => {
    dragState.current = null;
  };
  const onPointerLeave = () => {
    dragState.current = null;
    setScrubMs(null);
  };
  const selectLane = useCallback(
    (sessionId: string) => {
      if (!didDrag.current) onJumpToSession(sessionId);
    },
    [onJumpToSession],
  );

  // stable handler object so memo'd lane rows don't re-render on hover
  const popoverOpen = popover !== null;
  const pointerHandlers = useMemo<BlockPointerHandlers>(
    () => ({
      onBlockHover: (lane, block, clientX, clientY) => {
        if (popoverOpen) return; // popover has focus; tooltip would just overlap it
        setTooltip({ lane, block, x: clientX, y: clientY });
      },
      onBlockLeave: () => setTooltip(null),
      onBlockClick: (lane, block, clientX, clientY) => {
        if (didDrag.current) return; // a ≥3px pan must never open the popover
        setTooltip(null);
        setPopover({ lane, block, x: clientX, y: clientY });
      },
    }),
    [popoverOpen],
  );

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
        {attention.points.length > 0 ? (
          <span className="switch-badge" title="số lần bạn chuyển sự chú ý giữa các session trong cửa sổ">
            ⇄ {attention.switchCount} switches
          </span>
        ) : null}
        <span className="timeline-hint">kéo để pan · hover block xem chi tiết · click block để inspect</span>
      </div>
      {attention.points.length > 0 ? (
        <div className="timeline-ribbon-row">
          <div className="timeline-ribbon-spacer">prompts</div>
          <TimelineAttentionRibbon
            attention={attention}
            laneIndexBySession={laneIndexBySession}
            laneLabelBySession={laneLabelBySession}
            msToX={msToX}
            viewWidth={VIEW_W}
          />
        </div>
      ) : null}
      <div className="timeline-body">
        <div className="timeline-labels" style={{ paddingTop: AXIS_H }}>
          {lanes.map((lane, i) => (
            <div
              key={lane.sessionId}
              className={`timeline-label status-${lane.status}`}
              style={{ height: LANE_HEIGHT }}
              onClick={() => onJumpToSession(lane.sessionId)}
            >
              <span className={`status-dot status-dot-${lane.status}`} />
              <span className="lane-color-chip" style={{ background: laneColor(i) }} />
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
          onPointerLeave={onPointerLeave}
        >
          <defs>
            {/* diagonal amber stripes for waiting stretches */}
            <pattern id="wait-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="rgba(245, 166, 35, 0.10)" />
              <line x1={0} y1={0} x2={0} y2={6} stroke="rgba(245, 166, 35, 0.55)" strokeWidth={2} />
            </pattern>
          </defs>
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
                pointerHandlers={pointerHandlers}
              />
            ))}
          </g>
          {nowX >= 0 && nowX <= VIEW_W ? (
            <line x1={nowX} y1={AXIS_H - 4} x2={nowX} y2={height} className="now-line" />
          ) : null}
          {scrubMs !== null && popover === null ? (
            <g className="scrubber" pointerEvents="none">
              <line x1={msToX(scrubMs)} y1={AXIS_H - 8} x2={msToX(scrubMs)} y2={height} className="scrub-line" />
              <text x={msToX(scrubMs) + 4} y={AXIS_H - 10} className="scrub-time">
                {formatTick(scrubMs)}
              </text>
              {lanes.map((lane, i) => {
                const hit = lane.blocks.find((b) => scrubMs >= b.startMs && scrubMs <= b.endMs);
                const label = hit ? (hit.dominantTools[0] ?? hit.dominantCategory) : 'idle';
                const y = AXIS_H + i * LANE_HEIGHT + 8;
                return (
                  <text
                    key={lane.sessionId}
                    x={msToX(scrubMs) + 5}
                    y={y}
                    className={hit ? 'scrub-chip' : 'scrub-chip scrub-chip-idle'}
                  >
                    {label}
                  </text>
                );
              })}
            </g>
          ) : null}
        </svg>
      </div>
      {tooltip ? (
        <div
          className="timeline-tooltip"
          style={{
            left: Math.max(8, Math.min(tooltip.x + 12, globalThis.innerWidth - 320)),
            top: Math.max(8, Math.min(tooltip.y + 14, globalThis.innerHeight - 60)),
          }}
        >
          <strong>{tooltip.lane.label}</strong> · {formatTick(tooltip.block.startMs)}–{formatTick(tooltip.block.endMs)}
          <br />
          {tooltip.block.eventCount} events
          {tooltip.block.dominantTools.length > 0 ? ` · ${tooltip.block.dominantTools.join(', ')}` : ''}
          {tooltip.block.tokensIn + tooltip.block.tokensOut > 0
            ? ` · ▲${fmtTokensShort(tooltip.block.tokensIn)} ▼${fmtTokensShort(tooltip.block.tokensOut)}`
            : ''}
        </div>
      ) : null}
      {popover ? (
        <TimelineBlockPopover
          lane={popover.lane}
          block={popover.block}
          session={sessions.find((s) => s.sessionId === popover.lane.sessionId)}
          x={popover.x}
          y={popover.y}
          onClose={() => setPopover(null)}
          onOpenCard={onJumpToSession}
        />
      ) : null}
    </div>
  );
});
