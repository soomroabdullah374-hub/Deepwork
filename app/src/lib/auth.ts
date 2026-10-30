// Sign-in state. The session cookie lives in the phone's secure storage; the 15-minute
// JWT lives in memory and is refreshed through the API before it runs out.

import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useSyncExternalStore } from 'react';
import { ApiError, call } from './http';
import type { AuthResult, AuthUser } from './types';

const SESSION_KEY = 'deepwork.session';
const USER_KEY = 'deepwork.user';

export type AuthStatus = 'loading' | 'signed_out' | 'signed_in';
export interface AuthSnapshot {
  status: AuthStatus;
  user: AuthUser | null;
}

let session: string | null = null;
let jwt: { token: string; exp: number } | null = null;
let snapshot: AuthSnapshot = { status: 'loading', user: null };
const listeners = new Set<() => void>();
const signOutHandlers = new Set<() => void | Promise<void>>();

function set(next: Partial<AuthSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

export function useAuth(): AuthSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

export function getUser(): AuthUser | null {
  return snapshot.user;
}

/** Run when the user signs out or the session ends (clear caches, notifications…). */
export function onSignOut(handler: () => void | Promise<void>): () => void {
  signOutHandlers.add(handler);
  return () => signOutHandlers.delete(handler);
}

function decodeExp(token: string): number {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(globalThis.atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now() + 10 * 60_000;
  } catch {
    return Date.now() + 10 * 60_000;
  }
}

async function save(result: AuthResult) {
  session = result.session;
  jwt = { token: result.jwt, exp: decodeExp(result.jwt) };
  await SecureStore.setItemAsync(SESSION_KEY, result.session);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(result.user));
  set({ status: 'signed_in', user: result.user });
}

async function clear() {
  session = null;
  jwt = null;
  await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(USER_KEY).catch(() => undefined);
  set({ status: 'signed_out', user: null });
  for (const h of signOutHandlers) await Promise.resolve(h()).catch(() => undefined);
}

let refreshing: Promise<string> | null = null;

async function refresh(): Promise<string> {
  if (!session) throw new ApiError(401, 'signed_out', 'Please sign in.');
  if (!refreshing) {
    const current = session;
    refreshing = call<AuthResult>('POST', '/auth/token', { body: { session: current } })
      .then(async (result) => {
        await save(result);
        return result.jwt;
      })
      .catch(async (err) => {
        if (err instanceof ApiError && err.status === 401 && session === current) await clear();
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/** A JWT valid for at least another minute. */
export async function getToken(force = false): Promise<string> {
  if (!force && jwt && jwt.exp - Date.now() > 60_000) return jwt.token;
  return refresh();
}

/** Restore the saved session on launch. Offline launches keep the cached user. */
export async function bootstrap(): Promise<void> {
  session = await SecureStore.getItemAsync(SESSION_KEY).catch(() => null);
  const cached = await SecureStore.getItemAsync(USER_KEY).catch(() => null);
  const user = cached ? (JSON.parse(cached) as AuthUser) : null;
  if (!session) {
    set({ status: 'signed_out', user: null });
    return;
  }
  try {
    await refresh();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // clear() already ran
    set({ status: 'signed_in', user });
  }
}

export async function signIn(email: string, password: string) {
  await save(await call<AuthResult>('POST', '/auth/sign-in', { body: { email, password } }));
}

export async function signUp(name: string, email: string, password: string) {
  await save(await call<AuthResult>('POST', '/auth/sign-up', { body: { name, email, password } }));
}

export async function sendCode(email: string) {
  await call('POST', '/auth/code', { body: { email } });
}

export async function verifyCode(email: string, code: string) {
  await save(await call<AuthResult>('POST', '/auth/code/verify', { body: { email, code } }));
}

/** Google: open the provider in an auth session and finish with the returned verifier. */
export async function signInWithGoogle(): Promise<boolean> {
  const { url, challenge } = await call<{ url: string; challenge: string }>('POST', '/auth/social', {
    body: { provider: 'google' },
  });
  const result = await WebBrowser.openAuthSessionAsync(url, 'deepwork://auth/callback');
  if (result.type !== 'success') return false;
  const verifier = Linking.parse(result.url).queryParams?.neon_auth_session_verifier;
  if (typeof verifier !== 'string' || !verifier) {
    throw new ApiError(400, 'auth_failed', 'Google sign-in did not finish. Please try again.');
  }
  await save(await call<AuthResult>('POST', '/auth/social/finish', { body: { verifier, challenge } }));
  return true;
}

export async function signOut() {
  const current = session;
  if (current) await call('POST', '/auth/sign-out', { body: { session: current } }).catch(() => undefined);
  await clear();
}

/** After the account is deleted on the server. */
export async function forgetSession() {
  await clear();
}
