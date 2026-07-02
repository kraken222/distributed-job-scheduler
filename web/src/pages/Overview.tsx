import { Link } from 'react-router-dom';
import { Activity, HeartPulse } from 'lucide-react';
import { api } from '../api';
import { EmptyState, ErrorBanner, StatCard, StatusBadge, ThroughputChart, type Bucket } from '../components';
import { usePoll } from '../hooks';
import { PageHead, useProject } from '../App';
import { CreateProject } from './Queues';

interface Overview {
  totals: Record<string, number>;
  queues: { id: string; name: string; is_paused: number; priority: number; concurrency_limit: number; depth: number; running: number; dead: number }[];
  workers: { online: number; total: number };
  dlqSize: number;
  completedLastHour: number;
  failedLastHour: number;
}

export function Overview() {
  const { project } = useProject();
  const overview = usePoll(
    () => (project ? api<Overview>(`/api/projects/${project.id}/overview`) : Promise.resolve(null)),
    [project?.id],
  );
  const throughput = usePoll(
    () => (project ? api<{ data: Bucket[] }>(`/api/projects/${project.id}/throughput?minutes=30`) : Promise.resolve(null)),
    [project?.id],
    5000,
  );

  if (!project) {
    return (
      <EmptyState>
        <h2>Welcome 👋</h2>
        <p>Create your first project to start scheduling jobs.</p>
        <CreateProject />
      </EmptyState>
    );
  }
  const o = overview.data;
  const waiting = o ? (o.totals.queued ?? 0) + (o.totals.scheduled ?? 0) + (o.totals.retrying ?? 0) : 0;

  return (
    <>
      <PageHead title="Dashboard" subtitle={`Live health of the ${project.name} project — auto-refreshing`} />
      <ErrorBanner message={overview.error} />
      <div className="stat-grid">
        <StatCard label="Waiting" value={waiting} />
        <StatCard label="Running" value={o ? (o.totals.running ?? 0) + (o.totals.claimed ?? 0) : '…'} />
        <StatCard label="Completed (1h)" value={o?.completedLastHour ?? '…'} tone="ok" />
        <StatCard label="Failed (1h)" value={o?.failedLastHour ?? '…'} tone={o && o.failedLastHour > 0 ? 'bad' : undefined} />
        <StatCard
          label="Workers online"
          value={o ? `${o.workers.online}/${o.workers.total}` : '…'}
          tone={o && o.workers.online === 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Dead letters" value={o?.dlqSize ?? '…'} tone={o && o.dlqSize > 0 ? 'warn' : undefined} />
      </div>

      <section className="panel">
        <h2><Activity size={18} /> Throughput (last 30 min)</h2>
        {throughput.data ? <ThroughputChart buckets={throughput.data.data} /> : <p className="muted">Loading…</p>}
        <div className="legend">
          <span><i className="dot dot-ok" /> completed</span>
          <span><i className="dot dot-bad" /> failed</span>
        </div>
      </section>

      <section className="panel">
        <h2><HeartPulse size={18} /> Queue health</h2>
        {o && o.queues.length === 0 && <EmptyState>No queues yet — create one on the Queues page.</EmptyState>}
        {o && o.queues.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th>State</th>
                <th>Depth</th>
                <th>Running / Limit</th>
                <th>Dead</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              {o.queues.map((q) => (
                <tr key={q.id}>
                  <td><Link to={`/queues/${q.id}`}>{q.name}</Link></td>
                  <td>{q.is_paused ? <StatusBadge status="paused" /> : <StatusBadge status="active" />}</td>
                  <td>{q.depth}</td>
                  <td>
                    {q.running} / {q.concurrency_limit}
                    <div className="meter"><i style={{ width: `${Math.min(100, (q.running / q.concurrency_limit) * 100)}%` }} /></div>
                  </td>
                  <td>{q.dead > 0 ? <span className="text-bad">{q.dead}</span> : 0}</td>
                  <td>{q.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
