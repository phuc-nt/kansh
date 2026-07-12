// Bun HTTP + WebSocket server: sends a full snapshot on connect, then
// broadcasts incremental events. Binds localhost only — this dashboard
// exposes local transcript content and must not listen on external interfaces.

import type { ServerMessage as SharedServerMessage } from '../shared/normalized-event-types';
import type { SessionStateStore as Store } from './session-state-store';
import { jumpToSession } from './session-window-launcher';

const EVENTS_TOPIC = 'kansh-events';
const DIST_DIR = new URL('../../dist/', import.meta.url).pathname;

/** Serve the vite-built SPA from dist/; index.html for unknown paths. */
async function serveBuiltUi(pathname: string): Promise<Response> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  // stay inside dist/ — reject traversal
  if (relative.includes('..')) return new Response('not found', { status: 404 });
  const file = Bun.file(DIST_DIR + relative);
  if (await file.exists()) return new Response(file);
  const index = Bun.file(DIST_DIR + 'index.html');
  if (await index.exists()) return new Response(index);
  return new Response(
    'kansh server running (UI not built yet — run `bun run build`, or use `bun run dev` for the dev server). WS at /ws',
    { headers: { 'content-type': 'text/plain' } },
  );
}

export interface HubOptions {
  port: number;
  store: Store;
  /** resolves an event uuid to its full (truncated) transcript record */
  readEventDetail?: (uuid: string) => Promise<unknown | null>;
}

export function startWebsocketHub({ port, store, readEventDetail }: HubOptions) {
  // Cross-origin defense: browsers let any webpage open WebSockets to
  // 127.0.0.1 and send no-preflight POSTs. Transcripts are private — reject
  // every request whose Origin/Host isn't this server (or the vite dev UI).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([
    ...[...allowedHosts].map((h) => `http://${h}`),
    'http://127.0.0.1:5173', // vite dev server
    'http://localhost:5173',
  ]);
  const isAllowed = (request: Request): boolean => {
    const host = request.headers.get('host');
    if (host && !allowedHosts.has(host)) return false; // DNS rebinding
    const origin = request.headers.get('origin');
    return !origin || allowedOrigins.has(origin); // cross-origin pages
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request, srv) {
      if (!isAllowed(request)) return new Response('forbidden', { status: 403 });
      const url = new URL(request.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(request)) return undefined;
        return new Response('websocket upgrade required', { status: 400 });
      }
      if (url.pathname === '/api/snapshot') {
        return Response.json({ type: 'snapshot', sessions: store.snapshotAll() });
      }
      if (url.pathname === '/api/jump' && request.method === 'POST') {
        return (async () => {
          let sessionId = '';
          try {
            const body = (await request.json()) as { sessionId?: string };
            sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          } catch {
            // fall through to 400
          }
          const target = sessionId ? store.getJumpTarget(sessionId) : null;
          if (!target) return Response.json({ error: 'unknown session' }, { status: 400 });
          return Response.json(await jumpToSession(target));
        })();
      }
      if (url.pathname === '/api/event-detail') {
        const uuid = url.searchParams.get('uuid');
        if (!uuid || !readEventDetail) return Response.json({ detail: null }, { status: 404 });
        return (async () => {
          const detail = await readEventDetail(uuid);
          return Response.json({ detail }, { status: detail === null ? 404 : 200 });
        })();
      }
      return serveBuiltUi(url.pathname);
    },
    websocket: {
      open(ws) {
        ws.subscribe(EVENTS_TOPIC);
        const snapshot: SharedServerMessage = { type: 'snapshot', sessions: store.snapshotAll() };
        ws.send(JSON.stringify(snapshot));
      },
      close(ws) {
        ws.unsubscribe(EVENTS_TOPIC);
      },
      message() {
        // read-only monitor: clients don't send anything yet (Phase 3 adds detail requests)
      },
    },
  });

  const broadcast = (message: SharedServerMessage) => {
    server.publish(EVENTS_TOPIC, JSON.stringify(message));
  };

  return { server, broadcast };
}
