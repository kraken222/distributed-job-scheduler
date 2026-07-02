import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError, type ZodTypeAny } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ApiError } from './http.js';
import type { UserRole } from '../types.js';

export interface AuthUser {
  id: string;
  orgId: string;
  role: UserRole;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, org: user.orgId, role: user.role, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtTtlSeconds,
  });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(ApiError.unauthorized());
  try {
    const claims = jwt.verify(header.slice(7), config.jwtSecret) as jwt.JwtPayload;
    req.user = { id: claims.sub as string, orgId: claims.org, role: claims.role, email: claims.email };
    next();
  } catch {
    next(ApiError.unauthorized('Invalid or expired token'));
  }
}

/** RBAC: admin-only mutations (project/queue deletion, policy management). */
export function requireRole(role: UserRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.user?.role !== role) return next(ApiError.forbidden(`Requires ${role} role`));
    next();
  };
}

/** Validates req.body against a zod schema; replaces body with the parsed value. */
export function validateBody(schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(
        ApiError.badRequest(
          'Validation failed',
          result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }
    req.body = result.data;
    next();
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'bad_request', message: 'Validation failed', details: err.issues } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // SQLite unique violations surface as conflicts, not 500s.
  if (message.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: { code: 'conflict', message: 'A resource with those unique fields already exists' } });
    return;
  }
  logger.error({ err, path: req.path }, 'unhandled API error');
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
}

/** Structured request logging with latency. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();
  res.on('finish', () => {
    logger.info(
      { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(performance.now() - start), user: req.user?.id },
      'http',
    );
  });
  next();
}
