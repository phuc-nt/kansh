// Slide-in panel showing full detail for a clicked node: the event's own
// fields immediately, plus the raw transcript record fetched lazily.

import { useEffect, useState } from 'react';
import type { NormalizedEvent } from '../../shared/normalized-event-types';
import { eventColor } from './tool-node-glyph';

type FetchState = { status: 'loading' } | { status: 'done'; detail: unknown } | { status: 'unavailable' };

export function EventDetailSidePanel({
  event,
  onClose,
}: {
  event: NormalizedEvent;
  onClose: () => void;
}) {
  const [fetch_, setFetch] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setFetch({ status: 'loading' });
    fetch(`/api/event-detail?uuid=${encodeURIComponent(event.uuid)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { detail: unknown } | null) => {
        if (cancelled) return;
        setFetch(body && body.detail !== null ? { status: 'done', detail: body.detail } : { status: 'unavailable' });
      })
      .catch(() => {
        if (!cancelled) setFetch({ status: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [event.uuid]);

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <span className="detail-kind" style={{ color: eventColor(event) }}>
          {event.kind}
          {event.toolName ? ` · ${event.toolName}` : ''}
          {event.agentType ? ` · ${event.agentType}` : ''}
        </span>
        <button className="detail-close" onClick={onClose} aria-label="close detail">
          ✕
        </button>
      </div>
      <dl className="detail-fields">
        <dt>time</dt>
        <dd>{new Date(event.ts).toLocaleTimeString()}</dd>
        {event.agentId ? (
          <>
            <dt>agent</dt>
            <dd>{event.agentId}</dd>
          </>
        ) : null}
        {event.label ? (
          <>
            <dt>label</dt>
            <dd>{event.label}</dd>
          </>
        ) : null}
      </dl>
      {fetch_.status === 'loading' ? (
        <p className="detail-note">loading…</p>
      ) : fetch_.status === 'unavailable' ? (
        <p className="detail-note">full record unavailable (out of window)</p>
      ) : (
        <pre className="detail-json">{JSON.stringify(fetch_.detail, null, 2)}</pre>
      )}
    </aside>
  );
}
