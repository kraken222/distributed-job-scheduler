/** Minimal typed API client with JWT storage and structured error surfacing. */

const TOKEN_KEY = 'jobscheduler.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (res.status === 204) return undefined as T;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && getToken()) {
      setToken(null);
      window.location.href = '/login';
    }
    const err = payload?.error ?? {};
    throw new ApiRequestError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return payload as T;
}

export const fmtTime = (ms: number | null | undefined): string =>
  ms == null ? '—' : new Date(ms).toLocaleString();

export const fmtAgo = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return `in ${fmtDuration(-diff)}`;
  return `${fmtDuration(diff)} ago`;
};

export const fmtDuration = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
};
