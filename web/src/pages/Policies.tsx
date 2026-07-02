import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, fmtDuration } from '../api';
import { EmptyState, ErrorBanner } from '../components';
import { usePoll } from '../hooks';
import { PageHead, useProject } from '../App';

export interface RetryPolicy {
  id: string;
  project_id: string | null;
  name: string;
  strategy: 'fixed' | 'linear' | 'exponential';
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
}

const STRATEGY_HELP: Record<RetryPolicy['strategy'], string> = {
  fixed: 'same delay every retry',
  linear: 'delay grows: base × attempt',
  exponential: 'delay doubles each attempt',
};

/** Human preview of the first few backoff delays for a policy. */
function backoffPreview(p: { strategy: RetryPolicy['strategy']; base: number; max: number; attempts: number }): string {
  const delays: string[] = [];
  for (let attempt = 1; attempt < Math.min(p.attempts, 5); attempt++) {
    let d = p.strategy === 'fixed' ? p.base : p.strategy === 'linear' ? p.base * attempt : p.base * 2 ** (attempt - 1);
    delays.push(fmtDuration(Math.min(d, p.max)));
  }
  return delays.length ? delays.join(' → ') : 'no retries';
}

export function Policies() {
  const { project } = useProject();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    strategy: 'exponential' as RetryPolicy['strategy'],
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
  });

  const policies = usePoll(
    () =>
      project
        ? api<{ data: RetryPolicy[] }>(`/api/projects/${project.id}/retry-policies`)
        : Promise.resolve(null),
    [project?.id],
    10000,
  );

  if (!project) return <EmptyState>Create a project first.</EmptyState>;

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/projects/${project!.id}/retry-policies`, { method: 'POST', body: form });
      setForm({ ...form, name: '' });
      await policies.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function remove(p: RetryPolicy) {
    setError(null);
    try {
      await api(`/api/projects/${project!.id}/retry-policies/${p.id}`, { method: 'DELETE' });
      await policies.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <>
      <PageHead
        title="Retry policies"
        subtitle="How failed jobs back off before retrying — assign per queue or override per job"
      />
      <ErrorBanner message={policies.error ?? error} />

      <section className="panel">
        <h2>New policy</h2>
        <p className="panel-sub">Custom policies belong to the {project.name} project. System policies are read-only.</p>
        <form className="inline-form wrap" onSubmit={create}>
          <label className="field-inline grow">
            name
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="webhook-retries" />
          </label>
          <label className="field-inline">
            strategy
            <select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value as RetryPolicy['strategy'] })}>
              <option value="fixed">fixed</option>
              <option value="linear">linear</option>
              <option value="exponential">exponential</option>
            </select>
          </label>
          <label className="field-inline">
            max attempts
            <input type="number" min={1} max={50} value={form.maxAttempts} onChange={(e) => setForm({ ...form, maxAttempts: Number(e.target.value) })} style={{ width: 90 }} />
          </label>
          <label className="field-inline">
            base delay (ms)
            <input type="number" min={0} value={form.baseDelayMs} onChange={(e) => setForm({ ...form, baseDelayMs: Number(e.target.value) })} style={{ width: 110 }} />
          </label>
          <label className="field-inline">
            max delay (ms)
            <input type="number" min={0} value={form.maxDelayMs} onChange={(e) => setForm({ ...form, maxDelayMs: Number(e.target.value) })} style={{ width: 110 }} />
          </label>
          <button className="primary">
            <Plus size={16} /> Create policy
          </button>
        </form>
        <p className="muted small" style={{ marginTop: 10 }}>
          {STRATEGY_HELP[form.strategy]} — preview:{' '}
          <span className="mono">
            {backoffPreview({ strategy: form.strategy, base: form.baseDelayMs, max: form.maxDelayMs, attempts: form.maxAttempts + 1 })}
          </span>
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Policies</h2>
        </div>
        {policies.data && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Strategy</th>
                <th>Max attempts</th>
                <th>Backoff preview</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {policies.data.data.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td>{p.project_id ? <span className="badge badge-active">project</span> : <span className="badge badge-scheduled">system</span>}</td>
                  <td>{p.strategy}</td>
                  <td>{p.max_attempts}</td>
                  <td className="mono muted">
                    {backoffPreview({ strategy: p.strategy, base: p.base_delay_ms, max: p.max_delay_ms, attempts: p.max_attempts + 1 })}
                  </td>
                  <td>
                    {p.project_id && (
                      <button className="danger-button" onClick={() => remove(p)} title="Delete policy">
                        <Trash2 size={15} />
                      </button>
                    )}
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
