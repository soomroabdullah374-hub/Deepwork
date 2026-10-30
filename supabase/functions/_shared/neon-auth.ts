// Neon Auth (managed Better Auth) for the mobile app, called from the server.
//
// Better Auth keeps sessions in a signed cookie. A phone app has no browser cookie jar
// it can rely on, so the app sends its credentials here and gets back two things:
//   - `session`: the session cookie ("<name>=<signed value>"), kept in the phone's
//     secure storage and used only to get fresh access tokens and to sign out;
//   - `jwt`: the short-lived (15 min) Neon Auth JWT for every API call.
// Nothing is stored on the server.

import { config } from './env.ts';
import { fetchWithTimeout, HttpError } from './http.ts';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthResult {
  session: string;
  jwt: string;
  user: AuthUser;
}

/** Origin sent to Neon Auth: this project's own URL, which is in its trusted domains. */
function origin(): string {
  return config.supabaseUrl ? new URL(config.supabaseUrl).origin : 'https://localhost';
}

interface Call {
  res: Response;
  data: Record<string, unknown> | null;
  cookies: string[];
}

async function call(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; cookie?: string },
): Promise<Call> {
  const headers: Record<string, string> = { Origin: origin(), Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetchWithTimeout(`${config.neonAuthUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
  }, 20_000);
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0].trim()).filter((c) => c.includes('='));
  return { res, data, cookies };
}

const isSessionCookie = (pair: string) => pair.split('=')[0].endsWith('.session_token');

function authError(status: number, data: Record<string, unknown> | null): HttpError {
  const code = String(data?.code ?? '').toUpperCase();
  const message = String(data?.message ?? '');
  if (status === 429) return new HttpError(429, 'rate_limited', 'Too many tries. Wait a minute and try again.');
  if (code.includes('INVALID_EMAIL_OR_PASSWORD') || code === 'INVALID_PASSWORD' || code === 'USER_NOT_FOUND') {
    return new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
  }
  if (code.includes('ALREADY_EXISTS') || /already exists/i.test(message)) {
    return new HttpError(409, 'account_exists', 'An account with that email already exists. Sign in instead.');
  }
  if (code.includes('PASSWORD_TOO_SHORT')) return new HttpError(400, 'weak_password', 'Use at least 8 characters.');
  if (code.includes('PASSWORD_TOO_LONG')) return new HttpError(400, 'weak_password', 'That password is too long.');
  if (code.includes('INVALID_EMAIL')) return new HttpError(400, 'invalid_email', 'That email address does not look right.');
  if (code.includes('OTP') || /otp|code/i.test(message)) {
    return new HttpError(400, 'invalid_code', 'That code is not right or has expired. Ask for a new one.');
  }
  if (code.includes('EMAIL_NOT_VERIFIED')) {
    return new HttpError(403, 'email_not_verified', 'Please confirm your email first. We sent you a code.');
  }
  if (status === 401) return new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
  console.error('neon auth error', status, code, message.slice(0, 200));
  return new HttpError(502, 'auth_failed', 'Sign-in is not available right now. Please try again.');
}

function toUser(data: Record<string, unknown> | null): AuthUser | null {
  const u = (data?.user ?? null) as Record<string, unknown> | null;
  if (!u || typeof u.id !== 'string') return null;
  return { id: u.id, email: String(u.email ?? ''), name: String(u.name ?? '') };
}

/** Exchange a session cookie for a fresh JWT (and a rolled session cookie, if any). */
export async function sessionToken(session: string): Promise<AuthResult> {
  const got = await call('/get-session', { method: 'GET', cookie: session });
  if (!got.res.ok) throw authError(got.res.status, got.data);
  const user = toUser(got.data);
  if (!user) throw new HttpError(401, 'signed_out', 'Your session has ended. Please sign in again.');
  const rolled = got.cookies.find(isSessionCookie) ?? session;
  let jwt = got.res.headers.get('set-auth-jwt');
  if (!jwt) {
    const t = await call('/token', { method: 'GET', cookie: rolled });
    jwt = typeof t.data?.token === 'string' ? t.data.token : null;
  }
  if (!jwt) throw new HttpError(502, 'auth_failed', 'Could not start your session. Please try again.');
  return { session: rolled, jwt, user };
}

async function finishWithCookies(got: Call): Promise<AuthResult> {
  if (!got.res.ok) throw authError(got.res.status, got.data);
  const session = got.cookies.find(isSessionCookie);
  if (!session) throw authError(got.res.status === 200 ? 401 : got.res.status, got.data);
  return await sessionToken(session);
}

export async function signUp(email: string, password: string, name: string): Promise<AuthResult> {
  return await finishWithCookies(await call('/sign-up/email', { method: 'POST', body: { email, password, name } }));
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  return await finishWithCookies(await call('/sign-in/email', { method: 'POST', body: { email, password } }));
}

export async function sendCode(email: string): Promise<void> {
  const got = await call('/email-otp/send-verification-otp', { method: 'POST', body: { email, type: 'sign-in' } });
  if (!got.res.ok) throw authError(got.res.status, got.data);
}

export async function signInWithCode(email: string, otp: string): Promise<AuthResult> {
  return await finishWithCookies(await call('/sign-in/email-otp', { method: 'POST', body: { email, otp } }));
}

/**
 * Social sign-in, step 1: the provider's URL to open in the browser, plus the challenge
 * cookie that must come back with the verifier in step 2.
 */
export async function socialStart(provider: string, callbackURL: string): Promise<{ url: string; challenge: string }> {
  const got = await call('/sign-in/social', {
    method: 'POST',
    body: { provider, callbackURL, disableRedirect: true },
  });
  const url = typeof got.data?.url === 'string' ? got.data.url : null;
  if (!got.res.ok || !url) throw authError(got.res.status, got.data);
  return { url, challenge: got.cookies.join('; ') };
}

/** Social sign-in, step 2: trade the verifier from the redirect for a session. */
export async function socialFinish(verifier: string, challenge: string): Promise<AuthResult> {
  const got = await call(`/get-session?neon_auth_session_verifier=${encodeURIComponent(verifier)}`, {
    method: 'GET',
    cookie: challenge,
  });
  if (!got.res.ok) throw authError(got.res.status, got.data);
  const session = got.cookies.find(isSessionCookie);
  if (!session) throw new HttpError(401, 'signed_out', 'Google sign-in did not finish. Please try again.');
  return await sessionToken(session);
}

export async function signOut(session: string): Promise<void> {
  await call('/sign-out', { method: 'POST', body: {}, cookie: session }).catch(() => undefined);
}
