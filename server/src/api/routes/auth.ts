import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { DB } from '../../db/connection.js';
import { newId } from '../../core/ids.js';
import { ApiError, h } from '../http.js';
import { requireAuth, signToken, validateBody, type AuthUser } from '../middleware.js';

const registerSchema = z.object({
  organizationName: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

interface UserRecord {
  id: string;
  org_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'member';
}

export function authRoutes(db: DB): Router {
  const r = Router();

  /** Creates an organization and its first (admin) user. */
  r.post('/register', validateBody(registerSchema), h(async (req, res) => {
    const { organizationName, name, email, password } = req.body;
    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (existing) throw ApiError.conflict('An account with this email already exists');

    const hash = await bcrypt.hash(password, 10);
    const now = Date.now();
    const orgId = newId.org();
    const userId = newId.user();
    db.transaction(() => {
      db.prepare(`INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)`).run(orgId, organizationName, now);
      db.prepare(
        `INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
      ).run(userId, orgId, email, name, hash, now);
    })();

    const user: AuthUser = { id: userId, orgId, role: 'admin', email };
    res.status(201).json({ token: signToken(user), user: { id: userId, name, email, role: 'admin', organizationId: orgId } });
  }));

  r.post('/login', validateBody(loginSchema), h(async (req, res) => {
    const { email, password } = req.body;
    const record = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRecord | undefined;
    // Same error for unknown email and bad password — no account enumeration.
    if (!record || !(await bcrypt.compare(password, record.password_hash))) {
      throw ApiError.unauthorized('Invalid email or password');
    }
    const user: AuthUser = { id: record.id, orgId: record.org_id, role: record.role, email: record.email };
    res.json({ token: signToken(user), user: { id: record.id, name: record.name, email: record.email, role: record.role, organizationId: record.org_id } });
  }));

  r.get('/me', requireAuth, h((req, res) => {
    const row = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.org_id AS organizationId, o.name AS organizationName
         FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ?`,
      )
      .get(req.user!.id);
    if (!row) throw ApiError.unauthorized();
    res.json(row);
  }));

  return r;
}
