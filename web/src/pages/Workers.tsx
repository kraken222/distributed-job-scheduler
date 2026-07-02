import { api, fmtAgo, fmtTime } from '../api';
import { EmptyState, ErrorBanner, StatusBadge } from '../components';
import { usePoll } from '../hooks';
import { PageHead } from '../App';

export function Workers() {
  const workers = usePoll(() => api('/api/workers?limit=100'), [], 3000);

  return (
    <>
      <PageHead title="Workers" subtitle="Deployment-wide fleet: liveness, load and lifetime outcomes" />
      <ErrorBanner message={workers.error} />
      <section className="panel">
        {workers.data?.data.length === 0 && (
          <EmptyState>
            No workers registered yet. Start one with <code>npm run worker</code> in <code>server/</code>.
          </EmptyState>
        )}
        {workers.data && workers.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th>Host / PID</th>
                <th>Active / Slots</th>
                <th>Completed</th>
                <th>Failed</th>
                <th>Last heartbeat</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {workers.data.data.map((w: any) => (
                <tr key={w.id}>
                  <td>
                    {w.name} <span className="muted mono small">{w.id.slice(0, 10)}…</span>
                  </td>
                  <td><StatusBadge status={w.status} /></td>
                  <td className="mono">{w.hostname}:{w.pid}</td>
                  <td>
                    {w.active_jobs} / {w.concurrency}
                    <div className="meter"><i style={{ width: `${Math.min(100, (w.active_jobs / w.concurrency) * 100)}%` }} /></div>
                  </td>
                  <td className="text-ok">{w.completed_total}</td>
                  <td className={w.failed_total ? 'text-bad' : ''}>{w.failed_total}</td>
                  <td className="muted">{fmtAgo(w.last_heartbeat_at)}</td>
                  <td className="muted">{fmtTime(w.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
