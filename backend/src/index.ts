import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { startListener } from './realtime/listener.js';
import { attachWebSocketServer, WS_PATH } from './realtime/wsServer.js';
import { startSweeper } from './reservations/sweeper.js';

/**
 * Process bootstrap. The REST API and the WebSocket endpoint share one
 * `http.Server` — same port, same origin, and the session cookie travels with
 * the upgrade request without any extra handshake.
 */
async function main(): Promise<void> {
  // Schema and seed data first: everything below assumes the tables exist.
  await migrate();

  const server = http.createServer(createApp());
  attachWebSocketServer(server);

  startListener();
  startSweeper();

  // `listen` reports failure (EADDRINUSE, EACCES) through an event rather than
  // a rejected promise, so `main().catch` below would never see it and the
  // process would sit there having bound nothing.
  server.on('error', (err) => {
    console.error('startup failed', err);
    process.exit(1);
  });

  server.listen(config.port, () => {
    console.log(`cinema backend listening on http://localhost:${config.port} (ws ${WS_PATH})`);
  });
}

main().catch((err: unknown) => {
  console.error('startup failed', err);
  process.exit(1);
});
