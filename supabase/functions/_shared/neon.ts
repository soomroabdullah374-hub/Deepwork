// Client for the Neon Data API (PostgREST-compatible). Every call carries the user's own
// Neon Auth JWT, so Postgres runs it as `authenticated` with RLS on: the functions never
// hold a database password for user requests.

import { config } from './env.ts';
import { fetchWithTimeout, HttpError } from './http.ts';

interface PgError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

function parseDetail(details: string | null | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  try {
    const v = JSON.parse(details);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Map a Postgres/PostgREST error to an API error the app can show. */
export function toHttpError(status: number, body: PgError | null): HttpError {
  const code = body?.code ?? '';
  const message = body?.message ?? '';
  switch (code) {
    case '23P01': // exclusion_violation: the no_overlap constraint or a clash we raised
      return new HttpError(409, 'clash', 'That time is taken.', { with: parseDetail(body?.details) ?? null });
    case 'P0002':
      return new HttpError(404, 'not_found', message || 'Not found.');
    case 'P0001':
      return new HttpError(409, 'conflict', message || 'That change is no longer possible.');
    case '28000':
    case 'PGRST301':
    case 'PGRST302':
      return new HttpError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
    case '42501':
      return new HttpError(403, 'forbidden', 'You do not have access to that.');
    case '23505':
      return new HttpError(409, 'duplicate', 'That already exists.');
    case '22023':
    case '22P02':
    case '22007':
    case '22008':
    case '23502':
    case '23514':
    case '23503':
      return new HttpError(400, 'invalid', friendlyInvalid(code, message));
  }
  if (status === 401) return new HttpError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
  console.error('data api error', status, code, message);
  return new HttpError(502, 'db_error', 'The database could not finish that. Please try again.');
}

function friendlyInvalid(code: string, message: string): string {
  if (code === '22023' && message) return message; // raised by our functions with readable text
  if (code === '23514') return 'Some values are out of range.';
  if (code === '23503') return 'That item no longer exists.';
  return 'Some values are not valid.';
}

export class Db {
  constructor(private readonly token: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra,
    };
  }

  private async send<T>(path: string, init: RequestInit, attempt = 1): Promise<T> {
    const res = await fetchWithTimeout(`${config.neonDataApiUrl}${path}`, init, 25_000);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const err = body as PgError | null;
      // A Neon compute waking from scale-to-zero can turn away the first request. The
      // token was already verified here and a 401/503 means nothing ran, so one quick
      // retry is safe.
      if (attempt === 1 && (res.status === 401 || res.status === 503)) {
        console.warn('data api retry', res.status, err?.code ?? '', err?.message ?? '');
        await new Promise((resolve) => setTimeout(resolve, 500));
        return this.send<T>(path, init, 2);
      }
      throw toHttpError(res.status, err);
    }
    return body as T;
  }

  /** Call a SQL function. Volatile functions must be POSTed, which works for all. */
  rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.send<T>(`/rpc/${fn}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(args) });
  }

  insert<T = unknown>(table: string, row: Record<string, unknown>): Promise<T> {
    return this.send<T[]>(`/${table}?select=*`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(row),
    }).then((rows) => rows[0]);
  }

  select<T = unknown>(table: string, query: string): Promise<T[]> {
    return this.send<T[]>(`/${table}?${query}`, { method: 'GET', headers: this.headers() });
  }

  update<T = unknown>(table: string, query: string, patch: Record<string, unknown>): Promise<T[]> {
    return this.send<T[]>(`/${table}?${query}`, {
      method: 'PATCH',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    });
  }
}
