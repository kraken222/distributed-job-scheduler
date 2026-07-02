import { EventEmitter } from 'node:events';

/**
 * In-process notification bus. The API process emits a 'changed' signal
 * after every successful mutation; the WebSocket hub turns those into
 * push notifications for dashboard clients. Changes made by *other*
 * processes (workers) are detected separately via SQLite's data_version
 * pragma — see api/ws.ts.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function notifyChanged(scope: string): void {
  bus.emit('changed', scope);
}

export function onChanged(listener: (scope: string) => void): () => void {
  bus.on('changed', listener);
  return () => bus.off('changed', listener);
}
