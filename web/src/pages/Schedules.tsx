import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, fmtTime } from '../api';
import { EmptyState, ErrorBanner, StatusBadge } from '../components';
import { usePoll } from '../hooks';
import { PageHead, useProject } from '../App';
import type { QueueWithStats } from './Queues';

export function Schedules() {
  const { project } = useProject();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ queueId: '', name: '', cron: '*/5 * * * *', jobType: 'email.send', payload: '{}' });

  const data = usePoll(async () => {
    if (!project) return null;
    const queues = (await api<{ data: QueueWithStats[] }>(`/api/projects/${project.id}/queues`)).data;
    const schedules = (
      await Promise.all(
        queues.map(async (q) => {
          const s = await api<{ data: any[] }>(`/api/queues/${q.id}/schedules`);
          return s.data.map((row) => ({ ...row, queue_name: q.name }));
        }),
      )
    ).flat();
    return { queues, schedules };
  }, [project?.id], 5000);

  if (!project) return <EmptyState>Create a project first.</EmptyState>;

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const payload = form.payload.trim() ? JSON.parse(form.payload) : undefined;
      await api(`/api/queues/${form.queueId || data.data?.queues[0]?.id}/schedules`, {
        method: 'POST',
        body: { name: form.name, cron: form.cron, jobType: form.jobType, payload },
      });
      setForm({ ...form, name: '' });
      await data.refresh();
    } catch (err) {
      setError(err instanceof SyntaxError ? 'Payload must be valid JSON' : err instanceof Error ? err.message : 'Failed');
    }
  }

  async function toggle(s: any) {
    await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
    await data.refresh();
  }

  async function remove(s: any) {
    await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
    await data.refresh();
  }

  return (
    <>
      <PageHead title="Recurring schedules" subtitle="Cron-driven job creation — one job is enqueued per firing, exactly once" />
      <ErrorBanner message={data.error ?? error} />

      <section className="panel">
        <h2>New schedule</h2>
        <p className="panel-sub">Standard 5-field cron, e.g. */5 * * * * (every 5 minutes) or 0 9 * * MON-FRI.</p>
        <form className="inline-form wrap" onSubmit={create}>
          <label className="field-inline">
            queue
            <select value={form.queueId} onChange={(e) => setForm({ ...form, queueId: e.target.value })}>
              {data.data?.queues.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline grow">
            name
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="nightly-digest" />
          </label>
          <label className="field-inline">
            cron
            <input required className="mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} style={{ width: 120 }} />
          </label>
          <label className="field-inline">
            job type
            <input required value={form.jobType} onChange={(e) => setForm({ ...form, jobType: e.target.value })} style={{ width: 140 }} />
          </label>
          <label className="field-inline grow">
            payload
            <input className="mono" value={form.payload} onChange={(e) => setForm({ ...form, payload: e.target.value })} />
          </label>
          <button className="primary">
            <Plus size={16} /> Create
          </button>
        </form>
      </section>

      <section className="panel">
        {data.data?.schedules.length === 0 && <EmptyState>No schedules yet.</EmptyState>}
        {data.data && data.data.schedules.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Queue</th>
                <th>Cron</th>
                <th>Job type</th>
                <th>State</th>
                <th>Next run</th>
                <th>Last run</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.data.schedules.map((s: any) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.queue_name}</td>
                  <td className="mono">{s.cron}</td>
                  <td>{s.job_type}</td>
                  <td>{s.enabled ? <StatusBadge status="active" /> : <StatusBadge status="paused" />}</td>
                  <td className="muted">{fmtTime(s.next_run_at)}</td>
                  <td className="muted">{fmtTime(s.last_run_at)}</td>
                  <td>
                    <div className="inline-form">
                      <button onClick={() => toggle(s)}>{s.enabled ? 'Disable' : 'Enable'}</button>
                      <button className="danger-button" onClick={() => remove(s)} title="Delete schedule">
                        <Trash2 size={15} />
                      </button>
                    </div>
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
