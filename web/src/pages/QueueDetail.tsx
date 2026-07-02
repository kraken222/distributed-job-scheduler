import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pause, Play, Plus, Search, Settings2 } from 'lucide-react';
import { api, fmtAgo } from '../api';
import { EmptyState, ErrorBanner, Pagination, StatCard, StatusBadge } from '../components';
import { usePoll } from '../hooks';
import { BackLink, PageHead } from '../App';
import { PolicySelect } from './Queues';

const STATUS_FILTERS = ['', 'queued', 'scheduled', 'claimed', 'running', 'retrying', 'completed', 'dead', 'canceled'];
const KNOWN_TYPES = ['email.send', 'report.generate', 'http.request', 'math.fibonacci', 'demo.sleep', 'demo.flaky', 'demo.fail'];

interface QueueConfig {
  priority: number;
  concurrencyLimit: number;
  retryPolicyId: string | null;
}

export function QueueDetail() {
  const { queueId } = useParams();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [jobForm, setJobForm] = useState({
    type: 'demo.sleep',
    payload: '{"ms": 2000}',
    delayMs: 0,
    runAt: '',
    priority: 0,
    count: 1,
  });
  const [config, setConfig] = useState<QueueConfig | null>(null);

  const queue = usePoll(() => api(`/api/queues/${queueId}`), [queueId]);
  const jobs = usePoll(
    () =>
      api(
        `/api/queues/${queueId}/jobs?page=${page}&limit=15` +
          (status ? `&status=${status}` : '') +
          (search ? `&search=${encodeURIComponent(search)}` : ''),
      ),
    [queueId, page, status, search],
  );

  const q = queue.data;

  async function createJobs(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const payload = jobForm.payload.trim() ? JSON.parse(jobForm.payload) : undefined;
      const base: Record<string, unknown> = { type: jobForm.type, payload, priority: jobForm.priority };
      if (jobForm.runAt) {
        const runAt = new Date(jobForm.runAt).getTime();
        if (Number.isNaN(runAt)) throw new Error('Invalid run-at time');
        base.runAt = runAt;
      } else if (jobForm.delayMs > 0) {
        base.delayMs = jobForm.delayMs;
      }
      if (jobForm.count > 1) {
        await api(`/api/queues/${queueId}/batches`, {
          method: 'POST',
          body: { name: `manual-${Date.now()}`, jobs: Array.from({ length: jobForm.count }, () => base) },
        });
      } else {
        await api(`/api/queues/${queueId}/jobs`, { method: 'POST', body: base });
      }
      await Promise.all([jobs.refresh(), queue.refresh()]);
    } catch (err) {
      setError(err instanceof SyntaxError ? 'Payload must be valid JSON' : err instanceof Error ? err.message : 'Failed');
    }
  }

  async function saveConfig(e: FormEvent) {
    e.preventDefault();
    if (!config) return;
    try {
      await api(`/api/queues/${queueId}`, { method: 'PATCH', body: config });
      setConfig(null);
      await queue.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <>
      <BackLink to="/queues" label="Queues" />
      <PageHead
        title={
          <>
            {q?.name ?? '…'} {q?.is_paused ? <StatusBadge status="paused" /> : q ? <StatusBadge status="active" /> : null}
          </>
        }
        subtitle="Queue configuration, live stats and job explorer"
      >
        {q && (
          <>
            <button
              onClick={async () => {
                await api(`/api/queues/${queueId}/${q.is_paused ? 'resume' : 'pause'}`, { method: 'POST' });
                await queue.refresh();
              }}
            >
              {q.is_paused ? <><Play size={16} /> Resume</> : <><Pause size={16} /> Pause</>}
            </button>
            <button
              onClick={() =>
                setConfig({ priority: q.priority, concurrencyLimit: q.concurrency_limit, retryPolicyId: q.retry_policy_id })
              }
            >
              <Settings2 size={16} /> Configure
            </button>
          </>
        )}
      </PageHead>
      <ErrorBanner message={queue.error ?? jobs.error ?? error} />

      {config && q && (
        <section className="panel">
          <h2>Configuration</h2>
          <p className="panel-sub">Changes apply to future claims immediately.</p>
          <form className="inline-form" onSubmit={saveConfig}>
            <label className="field-inline">
              priority
              <input type="number" value={config.priority} onChange={(e) => setConfig({ ...config, priority: Number(e.target.value) })} style={{ width: 90 }} />
            </label>
            <label className="field-inline">
              concurrency limit
              <input type="number" min={1} value={config.concurrencyLimit} onChange={(e) => setConfig({ ...config, concurrencyLimit: Number(e.target.value) })} style={{ width: 90 }} />
            </label>
            <label className="field-inline">
              retry policy
              <PolicySelect
                projectId={q.project_id}
                value={config.retryPolicyId}
                onChange={(retryPolicyId) => setConfig({ ...config, retryPolicyId })}
              />
            </label>
            <button className="primary">Save</button>
            <button type="button" onClick={() => setConfig(null)}>Cancel</button>
          </form>
        </section>
      )}

      {q?.stats && (
        <div className="stat-grid">
          <StatCard label="Depth" value={q.stats.depth} />
          <StatCard label="Running" value={`${q.stats.running} / ${q.concurrency_limit}`} />
          <StatCard label="Completed (1h)" value={q.stats.completedLastHour} tone="ok" />
          <StatCard label="Failed (1h)" value={q.stats.failedLastHour} tone={q.stats.failedLastHour > 0 ? 'bad' : undefined} />
        </div>
      )}

      <section className="panel">
        <h2>Enqueue jobs</h2>
        <p className="panel-sub">
          Immediate by default. Set a delay or an absolute run time for delayed/scheduled jobs; count &gt; 1 creates a batch.
        </p>
        <form className="inline-form wrap" onSubmit={createJobs}>
          <label className="field-inline">
            type
            <input
              required
              list="job-types"
              value={jobForm.type}
              onChange={(e) => setJobForm({ ...jobForm, type: e.target.value })}
              style={{ width: 160 }}
            />
            <datalist id="job-types">
              {KNOWN_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="field-inline grow">
            payload (JSON)
            <input value={jobForm.payload} onChange={(e) => setJobForm({ ...jobForm, payload: e.target.value })} className="mono" />
          </label>
          <label className="field-inline">
            delay (ms)
            <input
              type="number" min={0} value={jobForm.delayMs}
              onChange={(e) => setJobForm({ ...jobForm, delayMs: Number(e.target.value), runAt: '' })}
              style={{ width: 100 }}
            />
          </label>
          <label className="field-inline">
            or run at
            <input
              type="datetime-local"
              value={jobForm.runAt}
              onChange={(e) => setJobForm({ ...jobForm, runAt: e.target.value, delayMs: 0 })}
            />
          </label>
          <label className="field-inline">
            priority
            <input type="number" value={jobForm.priority} onChange={(e) => setJobForm({ ...jobForm, priority: Number(e.target.value) })} style={{ width: 80 }} />
          </label>
          <label className="field-inline">
            count
            <input type="number" min={1} max={500} value={jobForm.count} onChange={(e) => setJobForm({ ...jobForm, count: Number(e.target.value) })} style={{ width: 80 }} />
          </label>
          <button className="primary">
            <Plus size={16} /> Enqueue
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Jobs</h2>
          <div className="inline-form">
            <label className="field-inline">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Search size={13} /> search</span>
              <input
                placeholder="id, type or payload"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                style={{ width: 190 }}
              />
            </label>
            <label className="field-inline">
              status
              <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s || 'all statuses'}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {jobs.data?.data.length === 0 && <EmptyState>No jobs match.</EmptyState>}
        {jobs.data && jobs.data.data.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Priority</th>
                  <th>Created</th>
                  <th>Runs</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.data.map((j: any) => (
                  <tr key={j.id}>
                    <td><Link to={`/jobs/${j.id}`} className="mono">{j.id.slice(0, 12)}…</Link></td>
                    <td>{j.type}</td>
                    <td><StatusBadge status={j.status} /></td>
                    <td>{j.attempts}</td>
                    <td>{j.priority}</td>
                    <td className="muted">{fmtAgo(j.created_at)}</td>
                    <td className="muted">{j.status === 'scheduled' || j.status === 'retrying' ? fmtAgo(j.run_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} totalPages={jobs.data.pagination.totalPages} onPage={setPage} />
          </>
        )}
      </section>
    </>
  );
}
