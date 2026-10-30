// Dispatcher: called by pg_cron every minute with the x-cron-secret header.
//
// - Marks sessions missed and closes ones left running (every tick).
// - Keeps every user's 14-day horizon filled (once an hour).
// - Sends due pushes through Firebase Cloud Messaging HTTP v1 (only when FCM is set up).
//
// It connects to Neon as the `dispatcher` role, which can run the worker_* functions and
// nothing else. Until NEON_DATABASE_URL_DISPATCHER is set it does nothing: the app keeps
// working because missed marking and the horizon also run whenever the app loads, and
// reminders are scheduled on the phone itself.

import { neon } from 'npm:@neondatabase/serverless@0.10.4';
import { importPKCS8, SignJWT } from 'npm:jose@5.9.6';
import { config, VERSION } from '../_shared/env.ts';
import { errorResponse, fetchWithTimeout, HttpError, json } from '../_shared/http.ts';
import { hasCronSecret } from '../_shared/cron.ts';
import { localTime } from '../_shared/time.ts';

interface PushJob {
  job_id: number;
  user_id: string;
  kind: 'lead' | 'start' | 'missed' | 'deadline' | 'briefing';
  block_id: string | null;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  lead_min: number | null;
  language: string;
  hide_titles: boolean;
  tz: string;
  goal_title: string | null;
  days_left: number | null;
  milestones_done: number | null;
  milestones_total: number | null;
  sessions_today: number | null;
  tokens: string[] | null;
}

// ───────────────────────── FCM
let accessToken: { value: string; expires: number } | null = null;

async function fcmAccessToken(): Promise<string> {
  if (accessToken && accessToken.expires > Date.now() + 60_000) return accessToken.value;
  const sa = JSON.parse(config.fcm.serviceAccountJson as string) as { client_email: string; private_key: string };
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  }, 15_000);
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`);
  const body = await res.json();
  accessToken = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return accessToken.value;
}

/** Notification text in the user's language; titles hidden when they asked for that. */
export function pushText(job: PushJob): { title: string; body: string } {
  const ur = job.language === 'ur-Latn';
  const name = job.hide_titles ? (ur ? 'Focus session' : 'Focus session') : (job.title ?? 'Focus session');
  const range = job.starts_at && job.ends_at ? `${localTime(job.starts_at, job.tz)}–${localTime(job.ends_at, job.tz)}` : '';
  switch (job.kind) {
    case 'lead':
      return ur
        ? { title: `${name} ${job.lead_min} minute mein`, body: `${range} · Tayyar ho jaiye.` }
        : { title: `${name} in ${job.lead_min} min`, body: `${range} · Time to get ready.` };
    case 'start':
      return ur
        ? { title: `${name} ka waqt`, body: `${range}. Abhi shuru karein ya 10 minute baad.` }
        : { title: `Time for ${name}`, body: `${range}. Start now or snooze 10 minutes.` };
    case 'missed':
      return ur
        ? { title: `${name} reh gaya`, body: 'Koi khaali waqt chun kar ise move kar dein.' }
        : { title: `${name} was missed`, body: 'Pick a free slot to move it.' };
    case 'deadline': {
      const goal = job.hide_titles ? 'Your goal' : (job.goal_title ?? 'Your goal');
      const days = job.days_left ?? 0;
      const progress = `${job.milestones_done ?? 0} of ${job.milestones_total ?? 0} milestones done.`;
      return ur
        ? { title: `${goal}: ${days} din baqi`, body: progress }
        : { title: `${goal} is due in ${days} day${days === 1 ? '' : 's'}`, body: progress };
    }
    case 'briefing': {
      const n = job.sessions_today ?? 0;
      return ur
        ? { title: 'Subah bakhair', body: `Aaj ${n} session${n === 1 ? '' : 's'} hain.` }
        : { title: 'Good morning', body: `${n} session${n === 1 ? '' : 's'} today.` };
    }
  }
}

async function sendPush(token: string, job: PushJob): Promise<'sent' | 'bad_token' | 'failed'> {
  const { title, body } = pushText(job);
  const link = job.block_id ? `deepwork://focus/${job.block_id}` : 'deepwork://today';
  const res = await fetchWithTimeout(
    `https://fcm.googleapis.com/v1/projects/${config.fcm.projectId}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${await fcmAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: { type: job.kind, block_id: job.block_id ?? '', url: link },
          android: { priority: 'high', notification: { channel_id: 'sessions', tag: `${job.kind}:${job.block_id ?? ''}` } },
          apns: { payload: { aps: { category: job.kind === 'start' || job.kind === 'lead' ? 'session' : undefined } } },
        },
      }),
    },
    15_000,
  );
  if (res.ok) return 'sent';
  const text = await res.text();
  if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text)) return 'bad_token';
  console.error('fcm send failed', res.status, text.slice(0, 200));
  return 'failed';
}

// ───────────────────────── tick
async function tick() {
  const url = config.dispatcherDbUrl;
  if (!url) return { skipped: 'NEON_DATABASE_URL_DISPATCHER is not set' };
  const sql = neon(url);
  const out: Record<string, unknown> = {};
  out.missed = (await sql`select worker_mark_missed() as r`)[0].r;
  if (new Date().getUTCMinutes() === 7) out.horizon = (await sql`select worker_extend_horizon() as r`)[0].r;

  if (!config.fcm.projectId || !config.fcm.serviceAccountJson) {
    out.push = 'FCM is not set up';
    return out;
  }
  const jobs = (await sql`select * from worker_claim_pushes()`) as unknown as PushJob[];
  const sent: number[] = [];
  const failed: number[] = [];
  const bad: string[] = [];
  for (const job of jobs) {
    let delivered = false;
    for (const token of job.tokens ?? []) {
      const result = await sendPush(token, job);
      if (result === 'sent') delivered = true;
      if (result === 'bad_token') bad.push(token);
    }
    (delivered ? sent : failed).push(job.job_id);
  }
  if (jobs.length) {
    out.finish = (await sql`select worker_finish_pushes(${sent}::bigint[], ${failed}::bigint[], ${bad}::text[]) as r`)[0].r;
  }
  out.push = { claimed: jobs.length, sent: sent.length, failed: failed.length, bad_tokens: bad.length };
  return out;
}

Deno.serve(async (req) => {
  try {
    if (new URL(req.url).pathname.endsWith('/health')) return json({ ok: true, version: VERSION });
    if (!(await hasCronSecret(req))) throw new HttpError(401, 'unauthorized', 'Not allowed.');
    return json({ ok: true, ...(await tick()) });
  } catch (err) {
    return errorResponse(err);
  }
});
