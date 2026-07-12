import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: vite serves the UI and proxies WebSocket to the kansh server (bun run start).
// Build: output lands in dist/, served statically by the kansh server itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4777', ws: true },
      '/api': { target: 'http://127.0.0.1:4777' },
    },
  },
  build: { outDir: 'dist' },
});
