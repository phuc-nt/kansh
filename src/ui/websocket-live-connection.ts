// Connects to the kansh server WebSocket and feeds the store.
// Reconnects with backoff; each reconnect receives a fresh snapshot,
// which fully replaces client state (safe against missed events).

import type { ServerMessage } from '../shared/normalized-event-types';
import type { SessionGraphStore } from './session-graph-store';

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];

export function startLiveConnection(store: SessionGraphStore): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    store.setConnection('connecting');
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    // capture per-connection: handlers of a stale socket must never touch the
    // current one (onclose of an old socket can fire after a new connect)
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    ws = socket;

    socket.onopen = () => {
      if (socket !== ws) return;
      attempt = 0;
      store.setConnection('open');
    };
    socket.onmessage = (msg) => {
      if (socket !== ws) return;
      try {
        store.applyServerMessage(JSON.parse(String(msg.data)) as ServerMessage);
      } catch {
        // malformed frame — ignore
      }
    };
    socket.onclose = () => {
      if (closed || socket !== ws) return;
      store.setConnection('closed');
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)];
      timer = setTimeout(connect, delay);
    };
    socket.onerror = () => socket.close();
  };

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
