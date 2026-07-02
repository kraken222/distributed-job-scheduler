import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polls an async loader on an interval (live updates without WebSockets).
 * Pauses while the tab is hidden to avoid useless traffic.
 */
export function usePoll<T>(loader: () => Promise<T>, deps: unknown[], intervalMs = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(async () => {
    try {
      setData(await loaderRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs]);

  return { data, error, loading, refresh };
}
