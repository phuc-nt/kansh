import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionGraphStore } from './session-graph-store';
import { startLiveConnection } from './websocket-live-connection';
import { DashboardGrid } from './components/dashboard-grid';
import './dashboard-styles.css';

const store = new SessionGraphStore();
const stopConnection = startLiveConnection(store);
// dev-only: without this, each vite HMR update stacks another live WebSocket
import.meta.hot?.dispose(stopConnection);

function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <DashboardGrid state={state} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
