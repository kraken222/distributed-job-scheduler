import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import type { DB } from '../db/connection.js';
import { config } from '../config.js';
import { onChanged } from '../core/bus.js';
import { logger } from '../logger.js';

/**
 * WebSocket live updates — implemented as a *notification* channel, exactly
 * the upgrade path the design doc reserved: the server never pushes data,
 * it pushes "something changed" pings and clients re-run their existing
 * REST fetchers (poll-on-notify). Tenancy therefore stays enforced in one
 * place (the REST layer) and a lost socket degrades to plain polling.
 *
 * Change detection covers both write paths:
 *  - API-local mutations → in-process bus (see notifyOnMutation in app.ts);
 *  - worker/other-process writes → SQLite's data_version pragma, which
 *    increments whenever another connection commits to the database file.
 *
 * Broadcasts are debounced so a burst of commits becomes one ping.
 */
export function attachWebSockets(server: Server, db: DB): { close(): void } {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    // Browsers cannot set headers on the WS handshake, so the JWT rides the
    // query string; it is verified before the upgrade completes.
    try {
      jwt.verify(url.searchParams.get('token') ?? '', config.jwtSecret);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket & { isAlive?: boolean }) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.send(JSON.stringify({ type: 'hello', at: Date.now() }));
  });

  // Debounced broadcast: coalesce bursts of changes into one ping.
  let pending: NodeJS.Timeout | null = null;
  function scheduleBroadcast() {
    if (pending || wss.clients.size === 0) return;
    pending = setTimeout(() => {
      pending = null;
      const msg = JSON.stringify({ type: 'changed', at: Date.now() });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
      }
    }, config.wsDebounceMs);
  }

  const unsubscribe = onChanged(scheduleBroadcast);

  // Cross-process change detection: data_version bumps when *another*
  // connection (a worker process) commits.
  let lastVersion = db.pragma('data_version', { simple: true }) as number;
  const versionTimer = setInterval(() => {
    try {
      const v = db.pragma('data_version', { simple: true }) as number;
      if (v !== lastVersion) {
        lastVersion = v;
        scheduleBroadcast();
      }
    } catch (err) {
      logger.error({ err }, 'data_version poll failed');
    }
  }, config.wsVersionPollMs);

  // Cull dead sockets (missed pong) so broadcasts don't pile up on zombies.
  const pingTimer = setInterval(() => {
    for (const client of wss.clients as Set<WebSocket & { isAlive?: boolean }>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);

  return {
    close() {
      unsubscribe();
      clearInterval(versionTimer);
      clearInterval(pingTimer);
      if (pending) clearTimeout(pending);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
