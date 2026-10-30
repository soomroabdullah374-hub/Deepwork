// The shared secret pg_cron sends as x-cron-secret. It was generated inside this
// project's database (Vault) and is read here with the service-role key, so it never
// appears in code, logs or settings screens.

import { config } from './env.ts';
import { fetchWithTimeout } from './http.ts';

let cached: { value: string; at: number } | null = null;

export async function cronSecret(): Promise<string | null> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
  const url = config.supabaseUrl;
  const key = config.supabaseServiceKey;
  if (!url || !key) return null;
  const res = await fetchWithTimeout(`${url}/rest/v1/rpc/dw_cron_secret`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  }, 10_000);
  if (!res.ok) {
    console.error('could not read the cron secret', res.status);
    return null;
  }
  const value = await res.json();
  if (typeof value !== 'string' || value.length < 32) return null;
  cached = { value, at: Date.now() };
  return value;
}

/** Constant-time comparison of the request's x-cron-secret header. */
export async function hasCronSecret(req: Request): Promise<boolean> {
  const expected = await cronSecret();
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
