import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from './api';

/**
 * Live updates via WebSocket (poll-on-notify): the server pushes "changed"
 * pings and every usePoll subscriber immediately re-runs its REST fetcher.
 * Polling stays on as a fallback, so a dropped socket only degrades
 * freshness back to the poll interval — nothing breaks.
 */

type Listener = () => void;
const changeListeners = new Set<Listener>();
const statusListeners = new Set<(up: boolean) => void>();
let socket: WebSocket | null = null;
let socketUp = false;
let reconnectDelay = 1000;

function setSocketUp(up: boolean) {
  if (socketUp === up) return;
  socketUp = up;
  for (const fn of statusListeners) fn(up);
}

function ensureSocket() {
  const token = getToken();
  if (!token || socket) return;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`);
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = 1000;
    setSocketUp(true);
  };
  ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(String(msg.data));
      if (data.type === 'changed') for (const fn of changeListeners) fn();
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onclose = () => {
    socket = null;
    setSocketUp(false);
    // Reconnect with capped exponential backoff while any subscriber remains.
    if (changeListeners.size > 0 || statusListeners.size > 0) {
      setTimeout(ensureSocket, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    }
  };
  ws.onerror = () => ws.close();
}

/** True while the live-update socket is connected (drives the sidebar indicator). */
export function useLiveStatus(): boolean {
  const [up, setUp] = useState(socketUp);
  useEffect(() => {
    statusListeners.add(setUp);
    ensureSocket();
    return () => {
      statusListeners.delete(setUp);
    };
  }, []);
  return up;
}

/**
 * Loads data via `loader`, refreshed by WebSocket change notifications the
 * instant anything mutates, with interval polling as the fallback transport.
 * Pauses while the tab is hidden to avoid useless traffic.
 */
export function usePoll<T>(loader: () => Promise<T>, deps: unknown[], intervalMs = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return; // coalesce overlapping notify+poll refreshes
    inFlight.current = true;
    try {
      setData(await loaderRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();

    const onNotify = () => {
      if (!document.hidden) void refresh();
    };
    changeListeners.add(onNotify);
    ensureSocket();

    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    return () => {
      changeListeners.delete(onNotify);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs]);

  return { data, error, loading, refresh };
}
