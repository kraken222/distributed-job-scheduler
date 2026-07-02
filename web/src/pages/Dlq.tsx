import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { api, fmtAgo } from '../api';
import { EmptyState, ErrorBanner, Pagination } from '../components';
import { usePoll } from '../hooks';
import { PageHead, useProject } from '../App';

export function Dlq() {
  const { project } = useProject();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const entries = usePoll(
    () => (project ? api(`/api/projects/${project.id}/dlq?page=${page}&limit=20`) : Promise.resolve(null)),
    [project?.id, page],
  );

  if (!project) return <EmptyState>Create a project first.</EmptyState>;

  async function requeue(id: string) {
    setError(null);
    try {
      await api(`/api/dlq/${id}/requeue`, { method: 'POST' });
      await entries.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <>
      <PageHead title="Dead Letter Queue" subtitle="Permanently failed jobs awaiting triage — requeue resets the attempt budget" />
      <ErrorBanner message={entries.error ?? error} />
      <section className="panel">
        {entries.data?.data.length === 0 && <EmptyState>🎉 Nothing here — no permanently failed jobs.</EmptyState>}
        {entries.data && entries.data.data.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Type</th>
                  <th>Queue</th>
                  <th>Attempts</th>
                  <th>Reason</th>
                  <th>Failed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.data.data.map((d: any) => (
                  <tr key={d.id}>
                    <td><Link to={`/jobs/${d.job_id}`} className="mono">{d.job_id.slice(0, 12)}…</Link></td>
                    <td>{d.job_type}</td>
                    <td>{d.queue_name}</td>
                    <td>{d.attempts}</td>
                    <td className="text-bad">{d.reason}</td>
                    <td className="muted">{fmtAgo(d.moved_at)}</td>
                    <td>
                      <button onClick={() => requeue(d.id)}>
                        <RotateCcw size={15} /> Requeue
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} totalPages={entries.data.pagination.totalPages} onPage={setPage} />
          </>
        )}
      </section>
    </>
  );
}
