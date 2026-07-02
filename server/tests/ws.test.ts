import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../src/api/app.js';
import { attachWebSockets } from '../src/api/ws.js';
import { signToken } from '../src/api/middleware.js';
import { notifyChanged } from '../src/core/bus.js';
import { testDb } from './helpers.js';

let server: Server;
let sockets: { close(): void };
let port: number;
const token = signToken({ id: 'usr_test', orgId: 'org_test', role: 'admin', email: 't@t.dev' });

beforeAll(async () => {
  const db = testDb();
  const app = createApp(db);
  server = app.listen(0);
  sockets = attachWebSockets(server, db);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  sockets.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connect(query: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?${query}`);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 20);
  });
}

describe('WebSocket live updates', () => {
  it('rejects upgrades without a valid JWT', async () => {
    await expect(connect('token=garbage')).rejects.toThrow(/401/);
  });

  it('greets authenticated clients and pushes change notifications', async () => {
    const { ws, messages } = await connect(`token=${token}`);
    try {
      await waitFor(() => messages.some((m) => m.type === 'hello'));
      notifyChanged('/api/test');
      await waitFor(() => messages.some((m) => m.type === 'changed'));
    } finally {
      ws.close();
    }
  });

  it('coalesces a burst of changes into few notifications', async () => {
    const { ws, messages } = await connect(`token=${token}`);
    try {
      await waitFor(() => messages.some((m) => m.type === 'hello'));
      for (let i = 0; i < 25; i++) notifyChanged(`/api/burst/${i}`);
      await waitFor(() => messages.some((m) => m.type === 'changed'));
      // Give any stragglers a moment, then assert the debounce collapsed the burst.
      await new Promise((r) => setTimeout(r, 400));
      expect(messages.filter((m) => m.type === 'changed').length).toBeLessThanOrEqual(3);
    } finally {
      ws.close();
    }
  });
});
