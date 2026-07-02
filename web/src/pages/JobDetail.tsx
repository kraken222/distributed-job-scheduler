import { useParams } from 'react-router-dom';
import { Ban, RotateCcw } from 'lucide-react';
import { api, fmtDuration, fmtTime } from '../api';
import { ErrorBanner, JsonBlock, StatusBadge } from '../components';
import { usePoll } from '../hooks';
import { BackLink, PageHead } from '../App';
import { useState } from 'react';

export function JobDetail() {
  const { jobId } = useParams();
  const [error, setError] = useState<string | null>(null);
  const job = usePoll(() => api(`/api/jobs/${jobId}`), [jobId], 2000);
  const executions = usePoll(() => api(`/api/jobs/${jobId}/executions`), [jobId], 2000);
  const logs = usePoll(() => api(`/api/jobs/${jobId}/logs`), [jobId], 2000);

  const j = job.data;

  async function act(action: 'retry' | 'cancel') {
    setError(null);
    try {
      await api(`/api/jobs/${jobId}/${action}`, { method: 'POST' });
      await job.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <>
      {j && <BackLink to={`/queues/${j.queue_id}`} label={`Queue ${j.queue_name}`} />}
      <PageHead
        title={<span className="mono" style={{ fontSize: 20 }}>{jobId}</span>}
        subtitle={j ? `${j.type} · payload, retry history and logs` : undefined}
      >
        {j && ['dead', 'canceled', 'completed', 'retrying'].includes(j.status) && (
          <button className="primary" onClick={() => act('retry')}>
            <RotateCcw size={16} /> Retry now
          </button>
        )}
        {j && ['scheduled', 'queued', 'retrying'].includes(j.status) && (
          <button className="danger-button" onClick={() => act('cancel')}>
            <Ban size={16} /> Cancel
          </button>
        )}
      </PageHead>
      <ErrorBanner message={job.error ?? error} />

      {j && (
        <section className="panel">
          <div className="detail-grid">
            <div><span className="muted">Status</span> <StatusBadge status={j.status} /></div>
            <div><span className="muted">Type</span> {j.type}</div>
            <div><span className="muted">Attempts</span> {j.attempts}</div>
            <div><span className="muted">Priority</span> {j.priority}</div>
            <div><span className="muted">Created</span> {fmtTime(j.created_at)}</div>
            <div><span className="muted">Runs at</span> {fmtTime(j.run_at)}</div>
            <div><span className="muted">Started</span> {fmtTime(j.started_at)}</div>
            <div><span className="muted">Finished</span> {fmtTime(j.completed_at)}</div>
            <div><span className="muted">Worker</span> {j.claimed_by ?? '—'}</div>
            <div><span className="muted">Timeout</span> {fmtDuration(j.timeout_ms)}</div>
            <div><span className="muted">Batch</span> {j.batch_id ?? '—'}</div>
            <div><span className="muted">Idempotency key</span> {j.idempotency_key ?? '—'}</div>
          </div>
          {j.last_error && <div className="error-banner">Last error: {j.last_error}</div>}
          <div className="two-col">
            <div>
              <h3>Payload</h3>
              <JsonBlock value={j.payload} />
            </div>
            <div>
              <h3>Result</h3>
              <JsonBlock value={j.result} />
            </div>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Executions (retry history)</h2>
        {executions.data?.data.length === 0 && <p className="muted">Not executed yet.</p>}
        {executions.data && executions.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Status</th>
                <th>Worker</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {executions.data.data.map((e: any) => (
                <tr key={e.id}>
                  <td>#{e.attempt}</td>
                  <td><StatusBadge status={e.status} /></td>
                  <td>{e.worker_name ?? e.worker_id}</td>
                  <td className="muted">{fmtTime(e.started_at)}</td>
                  <td>{fmtDuration(e.duration_ms)}</td>
                  <td className="text-bad">{e.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Logs</h2>
        {logs.data?.data.length === 0 && <p className="muted">No log lines.</p>}
        {logs.data && logs.data.data.length > 0 && (
          <div className="log-view">
            {logs.data.data.map((l: any) => (
              <div key={l.id} className={`log-line log-${l.level}`}>
                <span className="muted mono">{new Date(l.created_at).toLocaleTimeString()}</span>
                <span className={`log-level`}>{l.level}</span>
                <span>{l.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
