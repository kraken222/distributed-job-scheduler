/**
 * Seeds a demo org/user/project with queues, jobs and a cron schedule so the
 * dashboard has something to show immediately.
 *
 *   Login: demo@example.com / demo1234
 */
import bcrypt from 'bcryptjs';
import { openDatabase } from './connection.js';
import { newId } from '../core/ids.js';
import { createBatch, createJob } from '../core/jobService.js';
import { nextCronRun } from '../core/cron.js';

const db = openDatabase();
const now = Date.now();

const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get('demo@example.com');
if (existing) {
  console.log('Demo data already present — nothing to do.');
  process.exit(0);
}

const orgId = newId.org();
const userId = newId.user();
const projectId = newId.project();

db.prepare(`INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)`).run(orgId, 'Acme Inc', now);
db.prepare(
  `INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
).run(userId, orgId, 'demo@example.com', 'Demo Admin', bcrypt.hashSync('demo1234', 10), now);
db.prepare(`INSERT INTO projects (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(
  projectId,
  orgId,
  'notifications',
  'Demo project seeded with sample queues and jobs',
  now,
);

function makeQueue(name: string, priority: number, concurrency: number, retryPolicyId: string | null = null): string {
  const id = newId.queue();
  db.prepare(
    `INSERT INTO queues (id, project_id, name, priority, concurrency_limit, retry_policy_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, name, priority, concurrency, retryPolicyId, now, now);
  return id;
}

const emails = makeQueue('emails', 10, 5);
const reports = makeQueue('reports', 0, 2);
const flaky = makeQueue('flaky-integrations', 5, 3, 'rp_aggressive');

for (let i = 0; i < 8; i++) {
  createJob(db, emails, { type: 'email.send', payload: { to: `user${i}@example.com`, template: 'welcome' } });
}
createJob(db, emails, { type: 'email.send', payload: { to: 'later@example.com' }, delayMs: 120_000 });
createBatch(db, reports, {
  name: 'nightly-reports',
  jobs: Array.from({ length: 4 }, (_, i) => ({ type: 'report.generate', payload: { report: `region-${i}`, rows: 5000 } })),
});
for (let i = 0; i < 5; i++) {
  createJob(db, flaky, { type: 'demo.flaky', payload: { failRate: 0.6 } });
}
createJob(db, flaky, { type: 'demo.fail', payload: {}, retryPolicyId: 'rp_default' });

db.prepare(
  `INSERT INTO scheduled_jobs (id, queue_id, name, cron, timezone, job_type, payload, priority, timeout_ms, enabled, next_run_at, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0, 60000, 1, ?, ?, ?)`,
).run(
  newId.schedule(), emails, 'digest-every-minute', '* * * * *', 'UTC', 'email.send',
  JSON.stringify({ to: 'digest@example.com', template: 'digest' }),
  nextCronRun('* * * * *'), now, now,
);

console.log('Seeded demo data. Login with demo@example.com / demo1234');
db.close();
