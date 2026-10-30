// DeepWork API: one Supabase Edge Function for everything the app asks the server.
// Every user route verifies the Neon Auth JWT and talks to Neon through the Data API
// with that same JWT, so Postgres row-level security decides what each user can touch.
//
//   GET    /health                      versions and which providers are configured
//   GET    /auth/callback               bounce an OAuth redirect back into the app
//   POST   /auth/sign-up | sign-in      email + password → { session, jwt, user }
//   POST   /auth/code  /auth/code/verify  sign in with an emailed code
//   POST   /auth/social /auth/social/finish  Google sign-in (browser round trip)
//   POST   /auth/token                  session → fresh 15-minute JWT
//   POST   /auth/sign-out
//   GET    /state?from&to               profile, goals, commitments, blocks, streak
//   GET    /blocks?from&to&goal         blocks in a window
//   POST   /blocks/:id/:action          start | finish | skip | cancel | snooze | move | restore
//   GET    /blocks/:id/free-slots       free times to move a session to (with reasons)
//   GET    /free-slots?minutes&from&to  free starts on a 30-minute grid
//   PATCH  /profile                     settings
//   POST   /goals                       create (milestones + weekly rhythm)
//   POST   /goals/draft-plan            milestone draft for the New goal flow
//   PATCH  /goals/:id                   title, why, deadline, status
//   DELETE /goals/:id
//   PUT    /goals/:id/rule              weekly rhythm
//   PUT    /goals/:id/milestones        replace the plan
//   GET    /goals/:id/sessions          recent sessions
//   PATCH  /milestones/:id              { done }
//   POST   /commitments/check           clash check for a commitment before saving
//   POST   /commitments                 create
//   PATCH  /commitments/:id             update
//   DELETE /commitments/:id
//   POST   /devices  DELETE /devices    push token
//   GET    /export                      everything, as JSON
//   DELETE /account                     delete the account and all data
//   POST   /assistant/transcribe        audio → text (AssemblyAI)
//   POST   /assistant/plan              text → checked plan (LLM + clash checks)
//   POST   /assistant/answer            answer one of the plan's questions
//   POST   /assistant/apply             apply the chosen actions in one transaction
//   POST   /assistant/undo              undo within the window
//   GET|POST /assistant/speak           reply → speech (ElevenLabs)
//   POST   /assistant/eval              the 40-case eval (x-cron-secret only)

import { config, VERSION } from '../_shared/env.ts';
import { corsHeaders, errorResponse, HttpError, json, readJson } from '../_shared/http.ts';
import { type AuthUser, requireUser } from '../_shared/auth.ts';
import { Db } from '../_shared/neon.ts';
import * as neonAuth from '../_shared/neon-auth.ts';
import type { AppState } from '../_shared/state.ts';
import { occupies } from '../_shared/state.ts';
import {
  addDays,
  hhmm,
  isValidTimeZone,
  localDate,
  localTime,
  localToUtc,
  partOfDay,
  weekdayOf,
  WEEKDAYS_LONG,
} from '../_shared/time.ts';
import { transcribe } from '../_shared/assistant/stt.ts';
import { speak } from '../_shared/assistant/tts.ts';
import {
  guessReplyLanguage,
  LOW_CONFIDENCE,
  planWithLlm,
  promptContext,
  sayAgainPlan,
} from '../_shared/assistant/planner.ts';
import { isAutoApplicable, MUTATING_TYPES, type ResolvedAction, resolvePlan } from '../_shared/assistant/resolve.ts';
import { type Plan, PlanSchema } from '../_shared/assistant/schema.ts';
import { draftPlan } from '../_shared/assistant/draft.ts';
import { runEval } from '../_shared/assistant/eval.ts';
import { hasCronSecret } from '../_shared/cron.ts';

type Params = Record<string, string>;
interface Ctx {
  req: Request;
  url: URL;
  params: Params;
}
type Handler = (ctx: Ctx) => Response | Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-z_]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    }) + '/?$',
  );
  routes.push({ method, pattern, keys, handler });
}

// ───────────────────────── helpers
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: string | undefined, what = 'id'): string {
  if (!value || !UUID.test(value)) throw new HttpError(400, 'invalid', `That ${what} is not valid.`);
  return value;
}

function isoParam(url: URL, key: string, fallback: Date): string {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback.toISOString();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid', `${key} is not a valid time.`);
  return d.toISOString();
}

function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  const n = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, 'invalid', `${key} must be a number.`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function user(ctx: Ctx): Promise<{ me: AuthUser; db: Db }> {
  const me = await requireUser(ctx.req);
  return { me, db: new Db(me.token) };
}

function headerTimezone(req: Request): string | null {
  const tz = req.headers.get('x-timezone');
  return isValidTimeZone(tz) ? tz : null;
}

const DAY = 86_400_000;

/** app_state() over a window wide enough for the planner (yesterday … +16 days). */
async function loadState(ctx: Ctx, db: Db, me: AuthUser): Promise<AppState> {
  const now = Date.now();
  return await db.rpc<AppState>('app_state', {
    p_from: new Date(now - 8 * DAY).toISOString(),
    p_to: new Date(now + 16 * DAY).toISOString(),
    p_display_name: me.name ?? '',
    p_timezone: headerTimezone(ctx.req),
  });
}

// ───────────────────────── public
route('GET', '/health', () => {
  const llm = config.llm;
  return json({
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
    llm: { configured: Boolean(llm.apiKey), provider: llm.label, model: llm.model },
    speech_to_text: { configured: Boolean(config.assemblyAiKey), provider: 'AssemblyAI' },
    text_to_speech: { configured: Boolean(config.elevenLabs.apiKey), provider: 'ElevenLabs' },
    push: { configured: Boolean(config.fcm.projectId && config.fcm.serviceAccountJson && config.dispatcherDbUrl) },
  });
});

// Neon Auth sends social sign-in back here (an https URL it trusts); the app is opened
// with the same query so it can finish the sign-in with its own verifier cookie.
route('GET', '/auth/callback', ({ url }) => {
  const target = `deepwork://auth/callback${url.search}`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>DeepWork</title><body style="font-family:system-ui;padding:32px;text-align:center">` +
      `<p>Returning to DeepWork…</p><p><a href="${target.replace(/"/g, '&quot;')}">Open the app</a></p></body>`,
    { status: 302, headers: { Location: target, 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } },
  );
});

// ───────────────────────── sign-in (relayed to Neon Auth; nothing is stored here)
function validEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, 'invalid_email', 'That email address does not look right.');
  }
  return email;
}

function validPassword(value: unknown): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8) throw new HttpError(400, 'weak_password', 'Use at least 8 characters.');
  if (password.length > 128) throw new HttpError(400, 'weak_password', 'That password is too long.');
  return password;
}

function validSession(value: unknown): string {
  const session = typeof value === 'string' ? value.trim() : '';
  if (!/^[^=;\s]+\.session_token=[^;\s]+$/.test(session)) throw new HttpError(401, 'signed_out', 'Please sign in again.');
  return session;
}

route('POST', '/auth/sign-up', async ({ req }) => {
  const body = await readJson<{ email?: unknown; password?: unknown; name?: unknown }>(req);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  return json(await neonAuth.signUp(validEmail(body.email), validPassword(body.password), name), 201);
});

route('POST', '/auth/sign-in', async ({ req }) => {
  const body = await readJson<{ email?: unknown; password?: unknown }>(req);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) throw new HttpError(400, 'invalid_credentials', 'Enter your password.');
  return json(await neonAuth.signIn(validEmail(body.email), password));
});

route('POST', '/auth/code', async ({ req }) => {
  const body = await readJson<{ email?: unknown }>(req);
  await neonAuth.sendCode(validEmail(body.email));
  return json({ sent: true });
});

route('POST', '/auth/code/verify', async ({ req }) => {
  const body = await readJson<{ email?: unknown; code?: unknown }>(req);
  const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
  if (!/^\d{4,8}$/.test(code)) throw new HttpError(400, 'invalid_code', 'Enter the code from the email.');
  return json(await neonAuth.signInWithCode(validEmail(body.email), code));
});

route('POST', '/auth/social', async ({ req, url }) => {
  const body = await readJson<{ provider?: unknown }>(req);
  const provider = body.provider === 'google' ? 'google' : null;
  if (!provider) throw new HttpError(400, 'invalid', 'Unknown sign-in provider.');
  const callback = `${config.supabaseUrl ?? url.origin}/functions/v1/api/auth/callback`;
  return json(await neonAuth.socialStart(provider, callback));
});

route('POST', '/auth/social/finish', async ({ req }) => {
  const body = await readJson<{ verifier?: unknown; challenge?: unknown }>(req);
  const verifier = typeof body.verifier === 'string' ? body.verifier.trim() : '';
  const challenge = typeof body.challenge === 'string' ? body.challenge.trim() : '';
  if (!verifier || verifier.length > 512) throw new HttpError(400, 'invalid', 'The sign-in link is not valid.');
  return json(await neonAuth.socialFinish(verifier, challenge));
});

route('POST', '/auth/token', async ({ req }) => {
  const body = await readJson<{ session?: unknown }>(req);
  return json(await neonAuth.sessionToken(validSession(body.session)));
});

route('POST', '/auth/sign-out', async ({ req }) => {
  const body = await readJson<{ session?: unknown }>(req);
  if (typeof body.session === 'string' && body.session) await neonAuth.signOut(validSession(body.session));
  return json({ signed_out: true });
});

// ───────────────────────── state and blocks
route('GET', '/state', async (ctx) => {
  const { me, db } = await user(ctx);
  const now = Date.now();
  const state = await db.rpc<AppState>('app_state', {
    p_from: isoParam(ctx.url, 'from', new Date(now - 7 * DAY)),
    p_to: isoParam(ctx.url, 'to', new Date(now + 15 * DAY)),
    p_display_name: me.name ?? '',
    p_timezone: headerTimezone(ctx.req),
  });
  return json(state);
});

route('GET', '/blocks', async (ctx) => {
  const { db } = await user(ctx);
  const now = Date.now();
  const goal = ctx.url.searchParams.get('goal');
  return json(
    await db.rpc('list_blocks', {
      p_from: isoParam(ctx.url, 'from', new Date(now - 7 * DAY)),
      p_to: isoParam(ctx.url, 'to', new Date(now + 15 * DAY)),
      p_goal: goal ? uuid(goal, 'goal') : null,
    }),
  );
});

const BLOCK_ACTIONS = new Set(['start', 'finish', 'skip', 'cancel', 'snooze', 'move', 'restore']);
route('POST', '/blocks/:id/:action', async (ctx) => {
  const { db } = await user(ctx);
  const action = ctx.params.action;
  if (!BLOCK_ACTIONS.has(action)) throw new HttpError(404, 'not_found', 'Unknown action.');
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const p: Record<string, unknown> = {};
  if (action === 'finish' && body.minutes !== undefined) p.minutes = Number(body.minutes);
  if (action === 'skip' && typeof body.reason === 'string') p.reason = body.reason.slice(0, 280);
  if (action === 'snooze') p.minutes = Math.min(240, Math.max(5, Number(body.minutes ?? 10) || 10));
  if (action === 'move') {
    if (typeof body.starts_at !== 'string' || Number.isNaN(new Date(body.starts_at).getTime())) {
      throw new HttpError(400, 'invalid', 'A new start time is needed.');
    }
    p.starts_at = new Date(body.starts_at).toISOString();
  }
  if (action === 'restore') {
    if (typeof body.status === 'string') p.status = body.status;
    if (typeof body.starts_at === 'string' && typeof body.ends_at === 'string') {
      p.period = `[${new Date(body.starts_at).toISOString()},${new Date(body.ends_at).toISOString()})`;
    }
  }
  return json(await db.rpc('block_action', { p_id: uuid(ctx.params.id, 'session'), p_action: action, p }));
});

// Move-a-missed-session sheet: the usual time first, then free evenings and days, each
// with a short reason ("Free after your class", "Evening is open", "Whole day is free").
route('GET', '/blocks/:id/free-slots', async (ctx) => {
  const { me, db } = await user(ctx);
  const id = uuid(ctx.params.id, 'session');
  const state = await loadState(ctx, db, me);
  const tz = state.profile.timezone;
  const block = state.blocks.find((b) => b.id === id);
  if (!block) throw new HttpError(404, 'not_found', 'Session not found.');
  const minutes = Math.round((new Date(block.ends_at).getTime() - new Date(block.starts_at).getTime()) / 60_000);
  const goal = state.goals.find((g) => g.id === block.goal_id);
  const usual = goal?.rule ? hhmm(goal.rule.start_time) : localTime(block.starts_at, tz);
  const days = intParam(ctx.url, 'days', 7, 1, 14);
  const now = new Date();
  const today = localDate(now, tz);

  const free = await db.rpc<{ starts_at: string; ends_at: string }[]>('free_slots', {
    p_duration_min: minutes,
    p_from: now.toISOString(),
    p_to: localToUtc(`${addDays(today, days)}T00:00`, tz).toISOString(),
    p_limit: 50,
    p_ignore: id,
    p_step_min: 30,
  });
  const others = state.blocks.filter((b) => occupies(b) && b.id !== id);
  const onDay = (date: string) => others.filter((b) => localDate(b.starts_at, tz) === date);

  const reason = (start: Date, end: Date): string => {
    const date = localDate(start, tz);
    const items = onDay(date);
    if (items.length === 0) return 'Whole day is free';
    const before = items
      .filter((b) => new Date(b.ends_at) <= start && start.getTime() - new Date(b.ends_at).getTime() <= 90 * 60_000)
      .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
    if (before) return `Free after ${before.kind === 'commitment' ? 'your ' : ''}${before.title}`;
    const part = partOfDay(localTime(start, tz));
    if (!items.some((b) => partOfDay(localTime(b.starts_at, tz)) === part)) {
      return `${part[0].toUpperCase()}${part.slice(1)} is open`;
    }
    return end.getTime() - start.getTime() > 0 ? 'Free' : '';
  };

  const out: { starts_at: string; ends_at: string; reason: string; taken?: { title: string } }[] = [];
  const seenDays = new Set<string>();
  for (let i = 0; i < days && out.length < 5; i++) {
    const date = addDays(today, i);
    const usualStart = localToUtc(`${date}T${usual}`, tz);
    const usualEnd = new Date(usualStart.getTime() + minutes * 60_000);
    const dayFree = free.filter((f) => localDate(f.starts_at, tz) === date);
    if (usualStart > now) {
      const clash = others.find((b) => new Date(b.starts_at) < usualEnd && usualStart < new Date(b.ends_at));
      if (clash && out.length === 0 && dayFree.length > 0) {
        out.push({
          starts_at: usualStart.toISOString(),
          ends_at: usualEnd.toISOString(),
          reason: `Already ${clash.title}`,
          taken: { title: clash.title },
        });
      } else if (!clash && dayFree.some((f) => new Date(f.starts_at).getTime() === usualStart.getTime())) {
        out.push({ starts_at: usualStart.toISOString(), ends_at: usualEnd.toISOString(), reason: reason(usualStart, usualEnd) });
        seenDays.add(date);
        continue;
      }
    }
    if (seenDays.has(date) || dayFree.length === 0) continue;
    // prefer an evening start, then the first free one
    const pick = dayFree.find((f) => {
      const t = localTime(f.starts_at, tz);
      return t >= '17:00' && t <= '21:00';
    }) ?? dayFree[0];
    out.push({ starts_at: pick.starts_at, ends_at: pick.ends_at, reason: reason(new Date(pick.starts_at), new Date(pick.ends_at)) });
    seenDays.add(date);
  }
  return json({ minutes, slots: out });
});

route('GET', '/free-slots', async (ctx) => {
  const { db } = await user(ctx);
  const now = Date.now();
  const ignore = ctx.url.searchParams.get('ignore');
  return json(
    await db.rpc('free_slots', {
      p_duration_min: intParam(ctx.url, 'minutes', 60, 15, 720),
      p_from: isoParam(ctx.url, 'from', new Date(now)),
      p_to: isoParam(ctx.url, 'to', new Date(now + 7 * DAY)),
      p_limit: intParam(ctx.url, 'limit', 10, 1, 50),
      p_ignore: ignore ? uuid(ignore) : null,
      p_step_min: intParam(ctx.url, 'step', 30, 5, 120),
    }),
  );
});

// ───────────────────────── profile
const PROFILE_KEYS = [
  'display_name', 'timezone', 'language', 'quiet_start', 'quiet_end', 'briefing_at', 'theme',
  'notifications_enabled', 'hide_titles', 'speak_replies', 'assistant_auto_apply', 'onboarded',
];
route('PATCH', '/profile', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const p = Object.fromEntries(Object.entries(body).filter(([k]) => PROFILE_KEYS.includes(k)));
  if (p.timezone !== undefined && !isValidTimeZone(String(p.timezone))) {
    throw new HttpError(400, 'invalid', 'Unknown time zone.');
  }
  return json(await db.rpc('update_profile', { p }));
});

// ───────────────────────── goals
function validRule(rule: unknown): Record<string, unknown> {
  const r = (rule ?? {}) as Record<string, unknown>;
  const weekdays = Array.isArray(r.weekdays) ? r.weekdays.map(Number).filter((d) => d >= 0 && d <= 6) : [];
  if (weekdays.length === 0) throw new HttpError(400, 'invalid', 'Pick at least one day.');
  if (typeof r.start_time !== 'string' || !/^\d{1,2}:\d{2}/.test(r.start_time)) {
    throw new HttpError(400, 'invalid', 'Pick a start time.');
  }
  const duration = Number(r.duration_min);
  if (!(duration >= 15 && duration <= 240)) throw new HttpError(400, 'invalid', 'Sessions are 15 to 240 minutes.');
  const lead = r.lead_min === undefined ? 10 : Number(r.lead_min);
  if (!(lead >= 0 && lead <= 120)) throw new HttpError(400, 'invalid', 'Reminders are 0 to 120 minutes before.');
  return { weekdays, start_time: hhmm(r.start_time), duration_min: duration, lead_min: lead };
}

function validTitle(title: unknown, min = 3, max = 80): string {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t.length < min || t.length > max) throw new HttpError(400, 'invalid', `The title needs ${min} to ${max} characters.`);
  return t;
}

function validDate(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, 'invalid', `${what} must be a date.`);
  }
  return value;
}

route('POST', '/goals', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const milestones = Array.isArray(body.milestones)
    ? body.milestones
      .map((m) => ({ title: String((m as { title?: unknown })?.title ?? '').trim().slice(0, 120) }))
      .filter((m) => m.title)
      .slice(0, 12)
    : [];
  const p = {
    title: validTitle(body.title),
    why: typeof body.why === 'string' ? body.why.trim().slice(0, 500) : null,
    deadline: validDate(body.deadline, 'The deadline'),
    milestones,
    rule: validRule(body.rule),
  };
  return json(await db.rpc('create_goal', { p }), 201);
});

route('POST', '/goals/draft-plan', async (ctx) => {
  const { me, db } = await user(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const profile = await db.rpc<{ timezone: string }>('ensure_profile', {
    p_display_name: me.name ?? '',
    p_timezone: headerTimezone(ctx.req),
  });
  const tz = profile.timezone;
  const rule = body.rule ? validRule(body.rule) : { weekdays: [1, 3, 5], duration_min: 60 };
  return json(
    await draftPlan({
      title: validTitle(body.title),
      why: typeof body.why === 'string' ? body.why : null,
      deadline: validDate(body.deadline, 'The deadline'),
      weekdays: rule.weekdays as number[],
      duration_min: rule.duration_min as number,
      today: localDate(new Date(), tz),
    }),
  );
});

route('PATCH', '/goals/:id', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const p: Record<string, unknown> = {};
  if (body.title !== undefined) p.title = validTitle(body.title);
  if (body.why !== undefined) p.why = typeof body.why === 'string' ? body.why.trim().slice(0, 500) : null;
  if (body.deadline !== undefined) p.deadline = validDate(body.deadline, 'The deadline');
  if (body.status !== undefined) {
    if (!['active', 'paused', 'done'].includes(String(body.status))) throw new HttpError(400, 'invalid', 'Unknown status.');
    p.status = body.status;
  }
  return json(await db.rpc('update_goal', { p_goal: uuid(ctx.params.id, 'goal'), p }));
});

route('DELETE', '/goals/:id', async (ctx) => {
  const { db } = await user(ctx);
  const out = await db.rpc('delete_goal', { p_goal: uuid(ctx.params.id, 'goal') });
  if (!out) throw new HttpError(404, 'not_found', 'Goal not found.');
  return json(out);
});

route('PUT', '/goals/:id/rule', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.req);
  return json(await db.rpc('update_rule', { p_goal: uuid(ctx.params.id, 'goal'), p: validRule(body) }));
});

route('PUT', '/goals/:id/milestones', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<{ milestones?: unknown }>(ctx.req);
  const items = (Array.isArray(body.milestones) ? body.milestones : [])
    .map((m) => m as { id?: unknown; title?: unknown; done?: unknown })
    .map((m) => ({
      ...(typeof m.id === 'string' && UUID.test(m.id) ? { id: m.id } : {}),
      title: String(m.title ?? '').trim().slice(0, 120),
      ...(typeof m.done === 'boolean' ? { done: m.done } : {}),
    }))
    .filter((m) => m.title)
    .slice(0, 20);
  return json(await db.rpc('replace_milestones', { p_goal: uuid(ctx.params.id, 'goal'), p_items: items }));
});

route('GET', '/goals/:id/sessions', async (ctx) => {
  const { db } = await user(ctx);
  return json(
    await db.rpc('recent_sessions', {
      p_goal: uuid(ctx.params.id, 'goal'),
      p_limit: intParam(ctx.url, 'limit', 10, 1, 50),
    }),
  );
});

route('PATCH', '/milestones/:id', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<{ done?: unknown }>(ctx.req);
  const out = await db.rpc('set_milestone_done', { p_id: uuid(ctx.params.id, 'milestone'), p_done: body.done === true });
  if (!out) throw new HttpError(404, 'not_found', 'Milestone not found.');
  return json(out);
});

// ───────────────────────── commitments
interface CommitmentInput {
  id?: string;
  title: string;
  weekdays: number[];
  start_time: string;
  duration_min: number;
  one_off_date: string | null;
  starts_on: string | null;
}

function validCommitment(body: Record<string, unknown>, needTitle = true): CommitmentInput {
  const weekdays = Array.isArray(body.weekdays) ? [...new Set(body.weekdays.map(Number))].filter((d) => d >= 0 && d <= 6) : [];
  const oneOff = body.one_off_date ? validDate(body.one_off_date, 'The date') : null;
  if (!oneOff && weekdays.length === 0) throw new HttpError(400, 'invalid', 'Pick at least one day.');
  if (typeof body.start_time !== 'string' || !/^\d{1,2}:\d{2}/.test(body.start_time)) {
    throw new HttpError(400, 'invalid', 'Pick a start time.');
  }
  const duration = Number(body.duration_min);
  if (!(duration >= 15 && duration <= 720)) throw new HttpError(400, 'invalid', 'Commitments are 15 minutes to 12 hours.');
  return {
    title: needTitle ? validTitle(body.title, 1, 80) : String(body.title ?? '').trim(),
    weekdays: oneOff ? [] : weekdays,
    start_time: hhmm(body.start_time),
    duration_min: duration,
    one_off_date: oneOff,
    starts_on: body.starts_on ? validDate(body.starts_on, 'The start date') : null,
  };
}

// Before saving: would any occurrence in the next 14 days overlap something?
route('POST', '/commitments/check', async (ctx) => {
  const { me, db } = await user(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const c = validCommitment(body, false);
  const id = typeof body.id === 'string' && UUID.test(body.id) ? body.id : null;
  const ignoreGoal = typeof body.ignore_goal === 'string' && UUID.test(body.ignore_goal) ? body.ignore_goal : null;
  const profile = await db.rpc<{ timezone: string }>('ensure_profile', {
    p_display_name: me.name ?? '',
    p_timezone: headerTimezone(ctx.req),
  });
  const tz = profile.timezone;
  const now = new Date();
  const today = localDate(now, tz);
  const slots: { starts_at: string; ends_at: string }[] = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    if (c.one_off_date ? d !== c.one_off_date : !c.weekdays.includes(weekdayOf(d))) continue;
    if (c.starts_on && d < c.starts_on) continue;
    const start = localToUtc(`${d}T${c.start_time}`, tz);
    const end = new Date(start.getTime() + c.duration_min * 60_000);
    if (end > now) slots.push({ starts_at: start.toISOString(), ends_at: end.toISOString() });
  }
  const rows = slots.length
    ? await db.rpc<{ index: number; clash: Record<string, string> | null }[]>('check_slots', {
      p_slots: slots,
      p_ignore_commitment: id,
      p_ignore_goal: ignoreGoal,
    })
    : [];
  const clashes = rows
    .filter((r) => r.clash)
    .map((r) => {
      const clash = r.clash as Record<string, string>;
      const day = localDate(clash.starts_at, tz);
      return {
        ...slots[r.index],
        with: clash,
        message: `That time is taken. ${WEEKDAYS_LONG[weekdayOf(day)].slice(0, 3)} ` +
          `${localTime(clash.starts_at, tz)}–${localTime(clash.ends_at, tz)} is ${clash.title}.`,
      };
    });
  return json({ ok: clashes.length === 0, occurrences: slots.length, clashes });
});

route('POST', '/commitments', async (ctx) => {
  const { db } = await user(ctx);
  const c = validCommitment(await readJson(ctx.req));
  return json(await db.rpc('save_commitment', { p: c }), 201);
});

route('PATCH', '/commitments/:id', async (ctx) => {
  const { db } = await user(ctx);
  const c = validCommitment(await readJson(ctx.req));
  return json(await db.rpc('save_commitment', { p: { ...c, id: uuid(ctx.params.id, 'commitment') } }));
});

route('DELETE', '/commitments/:id', async (ctx) => {
  const { db } = await user(ctx);
  const out = await db.rpc('delete_commitment', { p_id: uuid(ctx.params.id, 'commitment') });
  if (!out) throw new HttpError(404, 'not_found', 'Commitment not found.');
  return json(out);
});

// ───────────────────────── devices, export, account
route('POST', '/devices', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<{ token?: unknown; platform?: unknown }>(ctx.req);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (token.length < 20 || token.length > 4096) throw new HttpError(400, 'invalid', 'That device token is not valid.');
  const platform = body.platform === 'ios' ? 'ios' : 'android';
  return json(await db.rpc('register_device', { p_token: token, p_platform: platform }));
});

route('DELETE', '/devices', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<{ token?: unknown }>(ctx.req);
  if (typeof body.token !== 'string') throw new HttpError(400, 'invalid', 'A device token is needed.');
  return json((await db.rpc('unregister_device', { p_token: body.token })) ?? { removed: false });
});

route('GET', '/export', async (ctx) => {
  const { db } = await user(ctx);
  const data = await db.rpc('export_my_data');
  return json(data, 200, { 'Content-Disposition': 'attachment; filename="deepwork-export.json"' });
});

route('DELETE', '/account', async (ctx) => {
  const { db } = await user(ctx);
  return json(await db.rpc('delete_my_account'));
});

// ───────────────────────── assistant
const TIME_WORDS = [
  'baje', 'kal', 'aaj', 'parson', 'subah', 'shaam', 'dopahar', 'raat', 'sawa', 'sarhe', 'paune', 'ghanta',
  'itwaar', 'peer', 'mangal', 'budh', 'jumeraat', 'juma', 'hafta', 'har', 'cancel kar do', 'shift kar do',
  'add kar do', 'hata do', 'DeepWork',
];

route('POST', '/assistant/transcribe', async (ctx) => {
  const { db } = await user(ctx);
  const type = ctx.req.headers.get('content-type') ?? '';
  let audio: Uint8Array<ArrayBuffer>;
  if (type.startsWith('multipart/form-data')) {
    const form = await ctx.req.formData();
    const file = form.get('audio') ?? form.get('file');
    if (!(file instanceof File)) throw new HttpError(400, 'invalid', 'Send the recording as "audio".');
    audio = new Uint8Array(await file.arrayBuffer());
  } else {
    audio = new Uint8Array(await ctx.req.arrayBuffer());
  }
  if (audio.byteLength < 1000) throw new HttpError(400, 'too_short', 'That recording is too short. Hold to talk a little longer.');
  if (audio.byteLength > 8 * 1024 * 1024) throw new HttpError(413, 'too_long', 'Recordings can be up to 60 seconds.');

  const [goals, commitments] = await Promise.all([
    db.select<{ title: string }>('goals', 'select=title&status=neq.done'),
    db.select<{ title: string }>('commitments', 'select=title'),
  ]);
  const keyterms = [...new Set([...goals, ...commitments].map((x) => x.title).concat(TIME_WORDS))];
  const t = await transcribe(audio, keyterms);
  return json(t);
});

interface RunRow {
  id: string;
  transcript: string;
  language: string | null;
  plan: Plan & { meta?: unknown };
  checks: ResolvedAction[];
  applied_at: string | null;
}

function planResponse(run: { id: string; transcript: string }, plan: Plan, actions: ResolvedAction[], extra = {}) {
  const changes = actions.filter((a) => MUTATING_TYPES.includes(a.type));
  return {
    run_id: run.id,
    transcript: run.transcript,
    reply_language: plan.reply_language,
    reply_text: plan.reply_text,
    reply_tts: plan.reply_tts,
    actions,
    ready: changes.filter((a) => a.status === 'ok').length,
    ...extra,
  };
}

async function maybeAutoApply(db: Db, state: AppState, runId: string, actions: ResolvedAction[]) {
  if (!state.profile.assistant_auto_apply || !isAutoApplicable(actions)) return { auto_applied: false };
  try {
    const applied = await db.rpc('assistant_apply', {
      p_run: runId,
      p_indexes: actions.filter((a) => a.status === 'ok').map((a) => a.index),
    });
    return { auto_applied: true, applied };
  } catch (err) {
    // the review screen still lets them apply by hand
    console.warn('auto-apply failed', (err as Error).message);
    return { auto_applied: false };
  }
}

route('POST', '/assistant/plan', async (ctx) => {
  const { me, db } = await user(ctx);
  const body = await readJson<{ text?: unknown; confidence?: unknown; language?: unknown }>(ctx.req);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : '';
  if (!text) throw new HttpError(400, 'invalid', 'Say or type what to change.');
  const confidence = typeof body.confidence === 'number' ? body.confidence : null;
  const spoken = typeof body.language === 'string' ? body.language : null;

  const state = await loadState(ctx, db, me);
  const tz = state.profile.timezone;
  const now = new Date();

  let plan: Plan;
  let meta: Record<string, unknown> = {};
  if (confidence !== null && confidence < LOW_CONFIDENCE) {
    plan = sayAgainPlan(spoken === 'ur' ? 'ur-Latn' : guessReplyLanguage(text));
    meta = { low_confidence: confidence };
  } else {
    const result = await planWithLlm(
      text,
      promptContext({ tz, now, goals: state.goals, commitments: state.commitments, blocks: state.blocks }),
    );
    plan = result.plan;
    meta = { model: result.model, attempts: result.attempts };
  }

  const actions = await resolvePlan(plan, { state, tz, now }, db);
  const run = await db.insert<{ id: string; transcript: string }>('assistant_runs', {
    transcript: text.slice(0, 2000),
    language: spoken,
    plan: { ...plan, meta },
    checks: actions,
  });
  const auto = await maybeAutoApply(db, state, run.id, actions);
  return json(planResponse(run, plan, actions, auto));
});

// Answer one question card ("Cloud lab on Friday. What time?" → "18:00"), or give a new
// time for a card that clashed. Only that card is planned again; the rest of the plan
// stays, and everything is re-checked.
route('POST', '/assistant/answer', async (ctx) => {
  const { me, db } = await user(ctx);
  const body = await readJson<{ run_id?: unknown; index?: unknown; answer?: unknown }>(ctx.req);
  const runId = uuid(typeof body.run_id === 'string' ? body.run_id : undefined, 'assistant run');
  const index = Number(body.index);
  const answer = typeof body.answer === 'string' ? body.answer.trim().slice(0, 200) : '';
  if (!answer) throw new HttpError(400, 'invalid', 'Pick or say an answer.');

  const [rows, state] = await Promise.all([
    db.select<RunRow>('assistant_runs', `id=eq.${runId}&select=id,transcript,language,plan,checks,applied_at`),
    loadState(ctx, db, me),
  ]);
  const run = rows[0];
  if (!run) throw new HttpError(404, 'not_found', 'That request has expired. Please ask again.');
  if (run.applied_at) throw new HttpError(409, 'conflict', 'These changes were already applied.');
  const original = PlanSchema.parse({ ...run.plan, actions: run.plan.actions });
  const card = run.checks[index];
  if (!card || (card.status !== 'needs_answer' && card.status !== 'clash')) {
    throw new HttpError(400, 'invalid', 'That question was already answered.');
  }

  const tz = state.profile.timezone;
  const now = new Date();
  const { plan: answerPlan } = await planWithLlm(
    (card.status === 'clash'
      ? `"${card.summary}" clashes with ${card.clash?.title ?? 'something'}. Instead: ${answer}\n`
      : `About "${card.question ?? card.summary}": ${answer}\n`) +
      'Return the plan with ONLY the action(s) that this answer settles. Do not repeat the other changes.',
    promptContext({ tz, now, goals: state.goals, commitments: state.commitments, blocks: state.blocks }),
    [
      { role: 'user', content: run.transcript },
      { role: 'assistant', content: JSON.stringify({ ...original, actions: original.actions }) },
    ],
  );

  // splice the answer's actions in place of the question, dropping repeats of other cards
  const key = (a: Plan['actions'][number]) =>
    [a.type, a.goal_id, a.session_id, a.commitment_id, a.start_local, a.title?.toLowerCase()].join('|');
  const others = new Set(original.actions.filter((_, i) => i !== index).map(key));
  const fresh = answerPlan.actions.filter((a) => a.type !== 'none' && !others.has(key(a)));
  const actionsIn = [
    ...original.actions.slice(0, index),
    ...(fresh.length ? fresh : [original.actions[index]]),
    ...original.actions.slice(index + 1),
  ].slice(0, 8);
  const plan: Plan = {
    ...original,
    reply_text: answerPlan.reply_text || original.reply_text,
    reply_tts: answerPlan.reply_tts || original.reply_tts,
    actions: actionsIn,
  };
  const actions = await resolvePlan(plan, { state, tz, now }, db);
  const transcript = `${run.transcript}\n${answer}`.slice(0, 2000);
  await db.update('assistant_runs', `id=eq.${runId}`, { plan, checks: actions, transcript });
  return json(planResponse({ id: runId, transcript }, plan, actions));
});

route('POST', '/assistant/apply', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<{ run_id?: unknown; indexes?: unknown }>(ctx.req);
  const runId = uuid(typeof body.run_id === 'string' ? body.run_id : undefined, 'assistant run');
  const indexes = Array.isArray(body.indexes) ? body.indexes.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [];
  if (indexes.length === 0) throw new HttpError(400, 'invalid', 'Pick at least one change.');
  return json(await db.rpc('assistant_apply', { p_run: runId, p_indexes: indexes }));
});

route('POST', '/assistant/undo', async (ctx) => {
  const { db } = await user(ctx);
  const body = await readJson<{ run_id?: unknown }>(ctx.req);
  const runId = uuid(typeof body.run_id === 'string' ? body.run_id : undefined, 'assistant run');
  return json(await db.rpc('assistant_undo', { p_run: runId }));
});

async function speakRoute(ctx: Ctx, text: string, language: string): Promise<Response> {
  await requireUser(ctx.req);
  const clean = text.trim();
  if (!clean) throw new HttpError(400, 'invalid', 'Nothing to say.');
  const out = await speak(clean, language);
  if (ctx.url.searchParams.get('format') === 'json') return json({ audio: out.audio, mime: out.mime });
  return new Response(out.bytes, {
    headers: { 'Content-Type': out.mime, 'Cache-Control': 'private, max-age=600', ...corsHeaders },
  });
}

route('GET', '/assistant/speak', (ctx) =>
  speakRoute(ctx, ctx.url.searchParams.get('text') ?? '', ctx.url.searchParams.get('lang') ?? 'en'));
route('POST', '/assistant/speak', async (ctx) => {
  const body = await readJson<{ text?: unknown; language?: unknown }>(ctx.req);
  return speakRoute(ctx, typeof body.text === 'string' ? body.text : '', typeof body.language === 'string' ? body.language : 'en');
});

// The eval runs real model calls, so only the project's own cron secret may start it.
route('POST', '/assistant/eval', async (ctx) => {
  if (!(await hasCronSecret(ctx.req))) throw new HttpError(401, 'unauthorized', 'Not allowed.');
  const body = await readJson<{ cases?: unknown }>(ctx.req);
  const cases = Array.isArray(body.cases) ? body.cases.map(Number).filter((n) => n >= 1 && n <= 40) : undefined;
  const out = await runEval(cases);
  return json({ ...out, provider: config.llm.label, model: config.llm.model });
});

// ───────────────────────── server
function stripPrefix(pathname: string): string {
  // /functions/v1/api/x (local) or /api/x (hosted) → /x
  const p = pathname.replace(/^\/functions\/v1/, '').replace(/^\/api(?=\/|$)/, '');
  return p === '' ? '/' : p;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const url = new URL(req.url);
  const path = stripPrefix(url.pathname);
  try {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return await r.handler({ req, url, params });
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    throw new HttpError(404, 'not_found', 'Not found.');
  } catch (err) {
    return errorResponse(err);
  }
});
