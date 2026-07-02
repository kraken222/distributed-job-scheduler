import type { Request, Response, NextFunction } from 'express';

/** Application error carrying an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }

  static badRequest(msg: string, details?: unknown) { return new ApiError(400, 'bad_request', msg, details); }
  static unauthorized(msg = 'Authentication required') { return new ApiError(401, 'unauthorized', msg); }
  static forbidden(msg = 'Insufficient permissions') { return new ApiError(403, 'forbidden', msg); }
  static notFound(what = 'Resource') { return new ApiError(404, 'not_found', `${what} not found`); }
  static conflict(msg: string) { return new ApiError(409, 'conflict', msg); }
}

/** Wraps async route handlers so rejections reach the error middleware. */
export function h(fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export interface Page {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(req: Request, maxLimit = 100): Page {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit ?? 25) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

export function paginated<T>(data: T[], total: number, p: Page) {
  return { data, pagination: { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) } };
}

/** Parse a jobs.payload / result column for API responses. */
export function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
