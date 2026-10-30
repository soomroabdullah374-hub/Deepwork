import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-crypto', () => {
  let seed = 0;
  return {
    getRandomBytes: (n: number) => {
      seed += 1;
      return Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed * 11) & 255);
    },
  };
});

jest.mock('../storage', () => {
  const store = new Map<string, string>();
  return {
    store,
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  };
});

jest.mock('../http', () => ({ ...jest.requireActual<typeof import('../http')>('../http'), call: jest.fn() }));

type Storage = typeof import('../storage') & { store: Map<string, string> };

const CREDS = { email: 'phone-0123456789abcdef@deepwork.invalid', password: 'a'.repeat(48) };
const USER = { id: 'u0', email: CREDS.email, name: '' };

function token(): string {
  const payload = globalThis.btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).replace(/=+$/, '');
  return `header.${payload}.signature`;
}

const result = (n: number) => ({ session: `session-${n}`, jwt: token(), user: { ...USER, id: `u${n}` } });

// A fresh copy of the modules (and of the in-memory storage) for every test.
function load() {
  jest.resetModules();
  const http: typeof import('../http') = require('../http');
  const storage: Storage = require('../storage');
  const auth: typeof import('../auth') = require('../auth');
  const call = jest.mocked(http.call);
  const paths = () => call.mock.calls.map((c) => c[1]);
  return { http, storage, auth, call, paths };
}

describe("this phone's account", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('waits for the intro on first run, then creates the account without asking anything', async () => {
    const { auth, call, storage, paths } = load();
    await auth.bootstrap();
    expect(auth.getAuth().status).toBe('signed_out');
    expect(call).not.toHaveBeenCalled();

    call.mockResolvedValueOnce(result(1));
    await auth.startAccount();
    expect(paths()).toEqual(['/auth/sign-up']);
    const creds = JSON.parse(storage.store.get('deepwork.device')!);
    expect(creds.email).toMatch(/^phone-[0-9a-f]{16}@deepwork\.invalid$/);
    expect(creds.password).toMatch(/^[0-9a-f]{48}$/);
    expect(call.mock.calls[0][2]?.body).toEqual({ ...creds, name: '' });
    expect(auth.getAuth().status).toBe('signed_in');
    expect(storage.store.get('deepwork.session')).toBe('session-1');
  });

  it('refreshes the saved session on launch', async () => {
    const { auth, call, storage, paths } = load();
    storage.store.set('deepwork.session', 'session-1');
    storage.store.set('deepwork.device', JSON.stringify(CREDS));
    call.mockResolvedValueOnce(result(2));
    await auth.bootstrap();
    expect(paths()).toEqual(['/auth/token']);
    expect(call.mock.calls[0][2]?.body).toEqual({ session: 'session-1' });
    expect(auth.getAuth().status).toBe('signed_in');
    expect(storage.store.get('deepwork.session')).toBe('session-2');
  });

  it('signs in again with the same account when the session ran out', async () => {
    const { auth, call, http, storage, paths } = load();
    storage.store.set('deepwork.session', 'session-1');
    storage.store.set('deepwork.device', JSON.stringify(CREDS));
    call.mockRejectedValueOnce(new http.ApiError(401, 'signed_out', 'Your session has ended.'));
    call.mockResolvedValueOnce(result(3));
    await auth.bootstrap();
    expect(paths()).toEqual(['/auth/token', '/auth/sign-in']);
    expect(call.mock.calls[1][2]?.body).toEqual(CREDS);
    expect(storage.store.get('deepwork.device')).toBe(JSON.stringify(CREDS));
    expect(auth.getAuth().status).toBe('signed_in');
  });

  it('replaces an account that no longer exists', async () => {
    const { auth, call, http, storage, paths } = load();
    storage.store.set('deepwork.device', JSON.stringify(CREDS));
    call.mockRejectedValueOnce(new http.ApiError(401, 'invalid_credentials', 'Those do not match.'));
    call.mockResolvedValueOnce(result(4));
    await auth.bootstrap();
    expect(paths()).toEqual(['/auth/sign-in', '/auth/sign-up']);
    expect(JSON.parse(storage.store.get('deepwork.device')!).email).not.toBe(CREDS.email);
    expect(auth.getAuth().status).toBe('signed_in');
  });

  it('keeps the account and the cached user when launched offline', async () => {
    const { auth, call, http, storage } = load();
    storage.store.set('deepwork.session', 'session-1');
    storage.store.set('deepwork.device', JSON.stringify(CREDS));
    storage.store.set('deepwork.user', JSON.stringify(USER));
    call.mockRejectedValueOnce(new http.ApiError(0, 'offline', "Can't reach DeepWork."));
    await auth.bootstrap();
    expect(call).toHaveBeenCalledTimes(1);
    expect(auth.getAuth()).toEqual({ status: 'signed_in', user: USER });
    expect(storage.store.get('deepwork.device')).toBe(JSON.stringify(CREDS));
  });

  it('reuses a fresh token and shares one refresh between callers', async () => {
    const { auth, call, storage, paths } = load();
    storage.store.set('deepwork.session', 'session-1');
    storage.store.set('deepwork.device', JSON.stringify(CREDS));
    call.mockResolvedValueOnce(result(5));
    await auth.bootstrap();
    const first = await auth.getToken();
    expect(await auth.getToken()).toBe(first);
    expect(call).toHaveBeenCalledTimes(1);

    call.mockResolvedValueOnce(result(6));
    const [a, b] = await Promise.all([auth.getToken(true), auth.getToken(true)]);
    expect(a).toBe(b);
    expect(paths()).toEqual(['/auth/token', '/auth/token']);
  });

  it('forgets everything after "Delete all my data", then starts a fresh account', async () => {
    const { auth, call, storage, paths } = load();
    storage.store.set('deepwork.session', 'session-1');
    storage.store.set('deepwork.device', JSON.stringify(CREDS));
    call.mockResolvedValueOnce(result(7));
    await auth.bootstrap();
    const reset = jest.fn<() => void>();
    auth.onAccountReset(reset);

    await auth.forgetAccount();
    expect(storage.store.size).toBe(0);
    expect(auth.getAuth()).toEqual({ status: 'signed_out', user: null });
    expect(reset).toHaveBeenCalledTimes(1);

    call.mockResolvedValueOnce(result(8));
    await auth.startAccount();
    expect(paths()).toEqual(['/auth/token', '/auth/sign-up']);
    expect(JSON.parse(storage.store.get('deepwork.device')!).email).not.toBe(CREDS.email);
  });
});
