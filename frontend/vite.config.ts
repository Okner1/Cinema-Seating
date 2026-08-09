import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy the API (and the seat-map websocket) through the dev server so the
    // session cookie stays first-party in development too.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        ws: true,
      },
    },
  },
});
