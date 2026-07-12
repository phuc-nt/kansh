// Kansh server entrypoint: wires ingestion (discovery + tailing + parsing),
// liveness polling, and the WebSocket hub together. Read-only over ~/.claude.

import { SessionStateStore } from './session-state-store';
import { SessionTranscriptIngestion } from './session-transcript-ingestion';
import { startLivenessPolling } from './session-liveness-poller';
import { startWebsocketHub } from './websocket-hub';
import { EventDetailReader } from './event-detail-reader';
import { CLAUDE_PROJECTS_ROOT } from './session-discovery';

const PORT = Number(process.env.KANSH_PORT ?? 4777);
const LIVENESS_INTERVAL_MS = 3_000;

async function main() {
  // hub is created after the store, but the store's listeners need to publish
  // through the hub — resolve the cycle with a late-bound reference
  let broadcast: (message: Parameters<ReturnType<typeof startWebsocketHub>['broadcast']>[0]) => void = () => {};

  const store = new SessionStateStore({
    onSessionAdded: (session) => broadcast({ type: 'session-added', session }),
    onEvent: (event) => broadcast({ type: 'event', event }),
    onStatusChange: (sessionId, status, lastActivityAt, waitingReason) =>
      broadcast({ type: 'session-status', sessionId, status, lastActivityAt, waitingReason }),
  });

  const detailReader = new EventDetailReader();
  const ingestion = new SessionTranscriptIngestion(store, CLAUDE_PROJECTS_ROOT, detailReader);
  await ingestion.start();

  const hub = startWebsocketHub({
    port: PORT,
    store,
    readEventDetail: (uuid) => detailReader.read(uuid),
  });
  broadcast = hub.broadcast;

  const stopLiveness = startLivenessPolling(LIVENESS_INTERVAL_MS, (sample) =>
    store.applyLivenessSample(sample),
  );

  const shutdown = () => {
    stopLiveness();
    ingestion.stop();
    hub.server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[kansh] monitoring ~/.claude/projects — http://127.0.0.1:${PORT} (ws: /ws)`);
  console.log(`[kansh] sessions loaded: ${store.snapshotAll().length}`);
}

void main();
