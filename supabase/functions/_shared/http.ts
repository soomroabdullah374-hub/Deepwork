// JSON responses and errors shared by the Edge Functions.
// Errors always look like { error: { code, message, ...extra } } and never carry stack
// traces or upstream payloads.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, x-timezone, x-client-info, apikey, x-region, x-cron-secret',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders, ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  console.error('unhandled error', err instanceof Error ? err.stack ?? err.message : err);
  return json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } }, 500);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

/** Fetch with a timeout, so one slow upstream can't hold a request open. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new HttpError(504, 'upstream_timeout', 'The service took too long to answer.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
