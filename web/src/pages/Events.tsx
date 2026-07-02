import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Send, Trash2, Zap } from 'lucide-react';
import { api, fmtAgo } from '../api';
import { EmptyState, ErrorBanner, Pagination, StatusBadge } from '../components';
import { usePoll } from '../hooks';
import { PageHead, useProject } from '../App';

interface Queue {
  id: string;
  name: string;
}

/** Event-driven execution: emit events, manage the triggers that map them to jobs. */
export function Events() {
  const { project } = useProject();
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [emitForm, setEmitForm] = useState({ name: 'user.signup', payload: '{"userId": "u-1"}' });
  const [triggerForm, setTriggerForm] = useState({ eventName: 'user.signup', queueId: '', jobType: 'email.send', payload: '' });
  const [lastEmit, setLastEmit] = useState<string | null>(null);

  const triggers = usePoll(
    () => (project ? api(`/api/projects/${project.id}/triggers`) : Promise.resolve(null)),
    [project?.id],
  );
  const events = usePoll(
    () => (project ? api(`/api/projects/${project.id}/events?page=${page}&limit=15`) : Promise.resolve(null)),
    [project?.id, page],
  );

  useEffect(() => {
    if (!project) return;
    api<{ data: Queue[] }>(`/api/projects/${project.id}/queues`)
      .then((res) => {
        setQueues(res.data);
        setTriggerForm((f) => (f.queueId ? f : { ...f, queueId: res.data[0]?.id ?? '' }));
      })
      .catch(() => setQueues([]));
  }, [project?.id]);

  if (!project) return <EmptyState>Create a project first.</EmptyState>;

  async function emit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLastEmit(null);
    try {
      const payload = emitForm.payload.trim() ? JSON.parse(emitForm.payload) : undefined;
      const res = await api(`/api/projects/${project!.id}/events`, {
        method: 'POST',
        body: { name: emitForm.name, payload },
      });
      setLastEmit(`Event ${res.id} fanned out to ${res.jobIds.length} job(s)`);
      await events.refresh();
    } catch (err) {
      setError(err instanceof SyntaxError ? 'Payload must be valid JSON' : err instanceof Error ? err.message : 'Failed');
    }
  }

  async function createTrigger(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const payload = triggerForm.payload.trim() ? JSON.parse(triggerForm.payload) : undefined;
      await api(`/api/projects/${project!.id}/triggers`, {
        method: 'POST',
        body: { eventName: triggerForm.eventName, queueId: triggerForm.queueId, jobType: triggerForm.jobType, payload },
      });
      await triggers.refresh();
    } catch (err) {
      setError(err instanceof SyntaxError ? 'Payload must be valid JSON' : err instanceof Error ? err.message : 'Failed');
    }
  }

  async function toggleTrigger(t: any) {
    try {
      await api(`/api/projects/${project!.id}/triggers/${t.id}`, { method: 'PATCH', body: { enabled: !t.enabled } });
      await triggers.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function deleteTrigger(id: string) {
    try {
      await api(`/api/projects/${project!.id}/triggers/${id}`, { method: 'DELETE' });
      await triggers.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <>
      <PageHead
        title="Events"
        subtitle="Event-driven execution — emitted events fan out into jobs via triggers"
      />
      <ErrorBanner message={triggers.error ?? events.error ?? error} />

      <section className="panel">
        <h2><Zap size={16} style={{ verticalAlign: -2 }} /> Emit an event</h2>
        <p className="panel-sub">
          External systems POST the same shape to <code>/api/projects/…/events</code>. Every enabled trigger for the
          event name enqueues one job carrying the event payload.
        </p>
        <form className="inline-form" onSubmit={emit}>
          <label className="field-inline">
            event name
            <input required value={emitForm.name} onChange={(e) => setEmitForm({ ...emitForm, name: e.target.value })} style={{ width: 180 }} />
          </label>
          <label className="field-inline grow">
            payload (JSON)
            <input className="mono" value={emitForm.payload} onChange={(e) => setEmitForm({ ...emitForm, payload: e.target.value })} />
          </label>
          <button className="primary"><Send size={15} /> Emit</button>
        </form>
        {lastEmit && <p className="panel-sub" style={{ marginTop: 10 }}>✅ {lastEmit}</p>}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Triggers</h2>
        </div>
        <form className="inline-form" onSubmit={createTrigger} style={{ marginBottom: 14 }}>
          <label className="field-inline">
            on event
            <input required value={triggerForm.eventName} onChange={(e) => setTriggerForm({ ...triggerForm, eventName: e.target.value })} style={{ width: 150 }} />
          </label>
          <label className="field-inline">
            enqueue on
            <select required value={triggerForm.queueId} onChange={(e) => setTriggerForm({ ...triggerForm, queueId: e.target.value })}>
              {queues.map((q) => (
                <option key={q.id} value={q.id}>{q.name}</option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            job type
            <input required value={triggerForm.jobType} onChange={(e) => setTriggerForm({ ...triggerForm, jobType: e.target.value })} style={{ width: 150 }} />
          </label>
          <label className="field-inline grow">
            payload template (JSON)
            <input className="mono" placeholder="optional" value={triggerForm.payload} onChange={(e) => setTriggerForm({ ...triggerForm, payload: e.target.value })} />
          </label>
          <button className="primary"><Plus size={15} /> Add trigger</button>
        </form>

        {triggers.data?.data.length === 0 && <EmptyState>No triggers yet — add one above, then emit a matching event.</EmptyState>}
        {triggers.data && triggers.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Queue</th>
                <th>Job type</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {triggers.data.data.map((t: any) => (
                <tr key={t.id}>
                  <td className="mono">{t.event_name}</td>
                  <td>{t.queue_name}</td>
                  <td>{t.job_type}</td>
                  <td><StatusBadge status={t.enabled ? 'active' : 'paused'} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => toggleTrigger(t)}>{t.enabled ? 'Disable' : 'Enable'}</button>{' '}
                    <button className="danger-button" onClick={() => deleteTrigger(t.id)} title="Delete trigger">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Recent events</h2>
        {events.data?.data.length === 0 && <EmptyState>No events emitted yet.</EmptyState>}
        {events.data && events.data.data.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Name</th>
                  <th>Jobs created</th>
                  <th>Emitted</th>
                </tr>
              </thead>
              <tbody>
                {events.data.data.map((ev: any) => (
                  <tr key={ev.id}>
                    <td className="mono">{ev.id.slice(0, 12)}…</td>
                    <td>{ev.name}</td>
                    <td>{ev.jobs_created}</td>
                    <td className="muted">{fmtAgo(ev.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} totalPages={events.data.pagination.totalPages} onPage={setPage} />
          </>
        )}
      </section>
    </>
  );
}
