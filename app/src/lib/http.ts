// Plain HTTP to the DeepWork API (Supabase Edge Function). Errors become ApiError with
// the server's friendly message; a network failure becomes code "offline".

import Constants from 'expo-constants';
import { deviceTimeZone } from './time';

export const API_URL: string =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface CallOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  token?: string | null;
  timeoutMs?: number;
  /** A binary body (a recording). Expo's fetch can't send React Native's FormData files. */
  raw?: { bytes: Uint8Array<ArrayBuffer>; type: string };
}

export function buildUrl(path: string, query?: CallOptions['query']): string {
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${API_URL}${path}${qs ? `?${qs}` : ''}`;
}

export async function call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'x-timezone': deviceTimeZone() };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | Uint8Array<ArrayBuffer> | undefined;
  if (opts.raw) {
    headers['Content-Type'] = opts.raw.type;
    body = opts.raw.bytes;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, signal: controller.signal });
  } catch {
    throw new ApiError(0, 'offline', "Can't reach DeepWork. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'error',
      err?.message ?? 'Something went wrong. Please try again.',
      (err ?? {}) as Record<string, unknown>,
    );
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}
