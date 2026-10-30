// This phone's DeepWork account. There is no sign-in screen: the first time the app is
// used it creates a private account for the phone, with a random address and password
// kept in the phone's secure storage, and signs back in with them whenever the session
// runs out. The session cookie lives in secure storage too; the 15-minute JWT lives in
// memory and is refreshed through the API before it runs out.

import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { ApiError, call } from './http';
import { getItem, removeItem, setItem } from './storage';
import type { AuthResult, AuthUser } from './types';

const SESSION_KEY = 'deepwork.session';
const USER_KEY = 'deepwork.user';
const DEVICE_KEY = 'deepwork.device';

/** `signed_out`: no account on this phone yet (first run, or after deleting everything). */
export type AuthStatus = 'loading' | 'signed_out' | 'signed_in';
export interface AuthSnapshot {
  status: AuthStatus;
  user: AuthUser | null;
}

interface DeviceCredentials {
  email: string;
  password: string;
}

let session: string | null = null;
let jwt: { token: string; exp: number } | null = null;
let snapshot: AuthSnapshot = { status: 'loading', user: null };
const listeners = new Set<() => void>();
const resetHandlers = new Set<() => void | Promise<void>>();

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

export function getAuth(): AuthSnapshot {
  return snapshot;
}

/** Run when this phone's account is forgotten (clear caches, notifications…). */
export function onAccountReset(handler: () => void | Promise<void>): () => void {
  resetHandlers.add(handler);
  return () => resetHandlers.delete(handler);
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
  await setItem(SESSION_KEY, result.session);
  await setItem(USER_KEY, JSON.stringify(result.user));
  set({ status: 'signed_in', user: result.user });
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function loadCredentials(): Promise<DeviceCredentials | null> {
  const raw = await getItem(DEVICE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<DeviceCredentials>;
    return typeof c.email === 'string' && typeof c.password === 'string' ? { email: c.email, password: c.password } : null;
  } catch {
    return null;
  }
}

/** Sign in with this phone's account, creating it the first time. */
async function signInDevice(): Promise<string> {
  const existing = await loadCredentials();
  if (existing) {
    try {
      const result = await call<AuthResult>('POST', '/auth/sign-in', { body: existing });
      await save(result);
      return result.jwt;
    } catch (err) {
      // Offline or a busy server: keep the credentials and try again later. Only an
      // account that no longer exists is replaced.
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    }
  }
  // `.invalid` is reserved: the address can never receive mail.
  const fresh: DeviceCredentials = {
    email: `phone-${hex(Crypto.getRandomBytes(8))}@deepwork.invalid`,
    password: hex(Crypto.getRandomBytes(24)),
  };
  await setItem(DEVICE_KEY, JSON.stringify(fresh));
  const result = await call<AuthResult>('POST', '/auth/sign-up', { body: { ...fresh, name: '' } });
  await save(result);
  return result.jwt;
}

let refreshing: Promise<string> | null = null;

async function refresh(): Promise<string> {
  if (!refreshing) {
    const current = session;
    refreshing = (async () => {
      if (current) {
        try {
          const result = await call<AuthResult>('POST', '/auth/token', { body: { session: current } });
          await save(result);
          return result.jwt;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 401)) throw err;
          // The session ran out: sign in again below.
        }
      }
      return await signInDevice();
    })().finally(() => {
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

/** Restore this phone's account on launch. Offline launches keep the cached user. */
export async function bootstrap(): Promise<void> {
  session = await getItem(SESSION_KEY).catch(() => null);
  let user: AuthUser | null = null;
  try {
    user = JSON.parse((await getItem(USER_KEY).catch(() => null)) ?? 'null') as AuthUser | null;
  } catch {
    user = null;
  }
  if (!session && !(await loadCredentials())) {
    set({ status: 'signed_out', user: null });
    return;
  }
  try {
    await refresh();
  } catch {
    set({ status: 'signed_in', user });
  }
}

/** First run (or after deleting everything): create this phone's account and sign in. */
export async function startAccount(): Promise<void> {
  if (snapshot.status === 'signed_in' && session) return;
  await refresh();
}

/** After everything was deleted on the server: forget this phone's account too. */
export async function forgetAccount() {
  session = null;
  jwt = null;
  await removeItem(DEVICE_KEY).catch(() => undefined);
  await removeItem(SESSION_KEY).catch(() => undefined);
  await removeItem(USER_KEY).catch(() => undefined);
  set({ status: 'signed_out', user: null });
  for (const h of resetHandlers) await Promise.resolve(h()).catch(() => undefined);
}
