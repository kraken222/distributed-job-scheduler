import express from 'express';
import type { DB } from '../db/connection.js';
import { notifyChanged } from '../core/bus.js';
import { errorHandler, requestLogger, requireAuth } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { queueRoutes } from './routes/queues.js';
import { jobRoutes } from './routes/jobs.js';
import { eventRoutes } from './routes/events.js';

export function createApp(db: DB): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // The dashboard dev server (Vite) runs on another origin.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.use(requestLogger);

  // Live updates: any successful mutation pings WebSocket subscribers
  // (poll-on-notify — clients react by re-running their REST fetchers).
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      res.on('finish', () => {
        if (res.statusCode < 400) notifyChanged(req.path);
      });
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: Date.now() });
  });

  app.use('/api/auth', authRoutes(db));
  app.use('/api/projects', requireAuth, projectRoutes(db));
  app.use('/api', requireAuth, queueRoutes(db));
  app.use('/api', requireAuth, jobRoutes(db));
  app.use('/api', requireAuth, eventRoutes(db));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
