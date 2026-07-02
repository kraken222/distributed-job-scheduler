import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/api/app.js';
import { signToken } from '../src/api/middleware.js';
import { testDb } from './helpers.js';

let app: Express;
let token: string;
let projectId: string;
let queueId: string;

beforeAll(async () => {
  app = createApp(testDb());

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ organizationName: 'Acme', name: 'Ada', email: 'ada@acme.dev', password: 'password1' });
  expect(reg.status).toBe(201);
  token = reg.body.token;

  const proj = await request(app).post('/api/projects').set(auth()).send({ name: 'billing' });
  expect(proj.status).toBe(201);
  projectId = proj.body.id;

  const queue = await request(app)
    .post(`/api/projects/${projectId}/queues`)
    .set(auth())
    .send({ name: 'invoices', priority: 5, concurrencyLimit: 3 });
  expect(queue.status).toBe(201);
  queueId = queue.body.id;
});

function auth(t: string = token) {
  return { Authorization: `Bearer ${t}` };
}

describe('auth', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects bad credentials with a uniform error', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'ada@acme.dev', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('logs in and returns a usable token', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'ada@acme.dev', password: 'password1' });
    expect(res.status).toBe(200);
    const me = await request(app).get('/api/auth/me').set(auth(res.body.token));
    expect(me.body.email).toBe('ada@acme.dev');
    expect(me.body.role).toBe('admin');
  });

  it('rejects duplicate registrations', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ organizationName: 'X', name: 'Y', email: 'ada@acme.dev', password: 'password1' });
    expect(res.status).toBe(409);
  });
});

describe('validation and error shape', () => {
  it('returns structured field errors', async () => {
    const res = await request(app).post(`/api/queues/${queueId}/jobs`).set(auth()).send({ payload: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.details.some((d: any) => d.path === 'type')).toBe(true);
  });

  it('rejects invalid cron expressions', async () => {
    const res = await request(app)
      .post(`/api/queues/${queueId}/schedules`)
      .set(auth())
      .send({ name: 's', cron: 'banana', jobType: 't' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Invalid cron/);
  });
});

describe('jobs API', () => {
  it('creates immediate, delayed and batch jobs', async () => {
    const now = await request(app).post(`/api/queues/${queueId}/jobs`).set(auth()).send({ type: 'email.send', payload: { to: 'x' } });
    expect(now.status).toBe(201);
    expect(now.body.status).toBe('queued');

    const delayed = await request(app)
      .post(`/api/queues/${queueId}/jobs`)
      .set(auth())
      .send({ type: 'email.send', delayMs: 60000 });
    expect(delayed.body.status).toBe('scheduled');

    const batch = await request(app)
      .post(`/api/queues/${queueId}/batches`)
      .set(auth())
      .send({ name: 'b1', jobs: [{ type: 'a' }, { type: 'b' }] });
    expect(batch.status).toBe(201);
    expect(batch.body.total).toBe(2);
  });

  it('deduplicates by idempotency key with 200 instead of 201', async () => {
    const first = await request(app)
      .post(`/api/queues/${queueId}/jobs`)
      .set(auth())
      .send({ type: 't', idempotencyKey: 'k1' });
    const dup = await request(app)
      .post(`/api/queues/${queueId}/jobs`)
      .set(auth())
      .send({ type: 't', idempotencyKey: 'k1' });
    expect(first.status).toBe(201);
    expect(dup.status).toBe(200);
    expect(dup.body.id).toBe(first.body.id);
    expect(dup.body.deduplicated).toBe(true);
  });

  it('paginates and filters the job list', async () => {
    const page = await request(app).get(`/api/queues/${queueId}/jobs?limit=2&page=1`).set(auth());
    expect(page.status).toBe(200);
    expect(page.body.data.length).toBeLessThanOrEqual(2);
    expect(page.body.pagination.total).toBeGreaterThan(2);

    const filtered = await request(app).get(`/api/queues/${queueId}/jobs?status=scheduled`).set(auth());
    expect(filtered.body.data.every((j: any) => j.status === 'scheduled')).toBe(true);

    const bad = await request(app).get(`/api/queues/${queueId}/jobs?status=nope`).set(auth());
    expect(bad.status).toBe(400);
  });

  it('cancels pending jobs and rejects double-cancel', async () => {
    const job = await request(app).post(`/api/queues/${queueId}/jobs`).set(auth()).send({ type: 't', delayMs: 60000 });
    const cancel = await request(app).post(`/api/jobs/${job.body.id}/cancel`).set(auth());
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('canceled');
    const again = await request(app).post(`/api/jobs/${job.body.id}/cancel`).set(auth());
    expect(again.status).toBe(409);
  });
});

describe('queue management', () => {
  it('pauses and resumes queues', async () => {
    const paused = await request(app).post(`/api/queues/${queueId}/pause`).set(auth());
    expect(paused.body.is_paused).toBe(1);
    const resumed = await request(app).post(`/api/queues/${queueId}/resume`).set(auth());
    expect(resumed.body.is_paused).toBe(0);
  });

  it('reports queue stats', async () => {
    const res = await request(app).get(`/api/queues/${queueId}/stats`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.depth).toBeGreaterThanOrEqual(0);
    expect(res.body.byStatus).toBeTypeOf('object');
  });

  it('rejects duplicate queue names within a project', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/queues`).set(auth()).send({ name: 'invoices' });
    expect(res.status).toBe(409);
  });
});

describe('tenancy and RBAC', () => {
  it("hides other orgs' resources (404, not 403)", async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ organizationName: 'Rival', name: 'Eve', email: 'eve@rival.dev', password: 'password1' });
    const res = await request(app).get(`/api/projects/${projectId}`).set(auth(other.body.token));
    expect(res.status).toBe(404);
  });

  it('blocks non-admin users from destructive operations', async () => {
    const me = await request(app).get('/api/auth/me').set(auth());
    const memberToken = signToken({ id: 'usr_member', orgId: me.body.organizationId, role: 'member', email: 'm@acme.dev' });
    const res = await request(app).delete(`/api/projects/${projectId}`).set(auth(memberToken));
    expect(res.status).toBe(403);
  });
});
