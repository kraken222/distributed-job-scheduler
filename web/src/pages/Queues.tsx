import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Pause, Play, Plus } from 'lucide-react';
import { api, fmtDuration } from '../api';
import { EmptyState, ErrorBanner, StatusBadge } from '../components';
import { usePoll } from '../hooks';
import { PageHead, useProject } from '../App';
import type { RetryPolicy } from './Policies';

export interface QueueWithStats {
  id: string;
  name: string;
  priority: number;
  concurrency_limit: number;
  is_paused: number;
  retry_policy_id: string | null;
  stats: {
    depth: number;
    running: number;
    completedLastHour: number;
    failedLastHour: number;
    avgDurationMs: number | null;
    byStatus: Record<string, number>;
  };
}

export function CreateProject() {
  const { reloadProjects } = useProject();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/projects', { method: 'POST', body: { name } });
      setName('');
      setError(null);
      await reloadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <input required placeholder="project name" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="primary">
        <Plus size={16} /> Create project
      </button>
      <ErrorBanner message={error} />
    </form>
  );
}

/** Reusable retry-policy dropdown (system + project policies). */
export function PolicySelect({
  projectId,
  value,
  onChange,
  allowInherit,
}: {
  projectId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  allowInherit?: string;
}) {
  const policies = usePoll(
    () => api<{ data: RetryPolicy[] }>(`/api/projects/${projectId}/retry-policies`),
    [projectId],
    30000,
  );
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{allowInherit ?? 'default (exponential ×3)'}</option>
      {policies.data?.data.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.strategy}, {p.max_attempts} attempts)
        </option>
      ))}
    </select>
  );
}

export function Queues() {
  const { project } = useProject();
  const [form, setForm] = useState<{ name: string; priority: number; concurrencyLimit: number; retryPolicyId: string | null }>({
    name: '',
    priority: 0,
    concurrencyLimit: 10,
    retryPolicyId: null,
  });
  const [error, setError] = useState<string | null>(null);
  const queues = usePoll(
    () => (project ? api<{ data: QueueWithStats[] }>(`/api/projects/${project.id}/queues`) : Promise.resolve(null)),
    [project?.id],
  );

  if (!project) {
    return (
      <EmptyState>
        <p>Create a project first.</p>
        <CreateProject />
      </EmptyState>
    );
  }

  async function createQueue(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/projects/${project!.id}/queues`, { method: 'POST', body: form });
      setForm({ name: '', priority: 0, concurrencyLimit: 10, retryPolicyId: null });
      setError(null);
      await queues.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function toggle(q: QueueWithStats) {
    await api(`/api/queues/${q.id}/${q.is_paused ? 'resume' : 'pause'}`, { method: 'POST' });
    await queues.refresh();
  }

  return (
    <>
      <PageHead title="Queues" subtitle="Configuration, priorities, concurrency limits and live stats" />
      <ErrorBanner message={queues.error ?? error} />

      <section className="panel">
        <h2>New queue</h2>
        <p className="panel-sub">Higher priority queues are drained first. The concurrency limit applies fleet-wide.</p>
        <form className="inline-form wrap" onSubmit={createQueue}>
          <label className="field-inline grow">
            name
            <input
              required
              placeholder="e.g. emails"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field-inline">
            priority
            <input
              type="number"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              style={{ width: 80 }}
            />
          </label>
          <label className="field-inline">
            concurrency
            <input
              type="number"
              min={1}
              value={form.concurrencyLimit}
              onChange={(e) => setForm({ ...form, concurrencyLimit: Number(e.target.value) })}
              style={{ width: 90 }}
            />
          </label>
          <label className="field-inline">
            retry policy
            <PolicySelect projectId={project.id} value={form.retryPolicyId} onChange={(retryPolicyId) => setForm({ ...form, retryPolicyId })} />
          </label>
          <button className="primary">
            <Plus size={16} /> Create queue
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Queues</h2>
        </div>
        {queues.data && queues.data.data.length === 0 && <EmptyState>No queues yet.</EmptyState>}
        {queues.data && queues.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th>State</th>
                <th>Depth</th>
                <th>Running</th>
                <th>OK / Fail (1h)</th>
                <th>Avg duration</th>
                <th>Priority</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queues.data.data.map((q) => (
                <tr key={q.id}>
                  <td><Link to={`/queues/${q.id}`}>{q.name}</Link></td>
                  <td>{q.is_paused ? <StatusBadge status="paused" /> : <StatusBadge status="active" />}</td>
                  <td>{q.stats.depth}</td>
                  <td>{q.stats.running} / {q.concurrency_limit}</td>
                  <td>
                    <span className="text-ok">{q.stats.completedLastHour}</span> /{' '}
                    <span className={q.stats.failedLastHour ? 'text-bad' : ''}>{q.stats.failedLastHour}</span>
                  </td>
                  <td>{fmtDuration(q.stats.avgDurationMs)}</td>
                  <td>{q.priority}</td>
                  <td>
                    <button onClick={() => toggle(q)}>
                      {q.is_paused ? <><Play size={15} /> Resume</> : <><Pause size={15} /> Pause</>}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
