// Verifies the Neon Auth (Managed Better Auth) JWT the app sends on every request.
// Keys come from Neon Auth's JWKS and are cached by jose between requests.

import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.9.6';
import { config } from './env.ts';
import { HttpError } from './http.ts';

const jwksUrl = new URL(`${config.neonAuthUrl}/.well-known/jwks.json`);
const issuer = new URL(config.neonAuthUrl).origin;
const jwks = createRemoteJWKSet(jwksUrl, { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 });

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  /** The raw JWT, forwarded to the Neon Data API so RLS sees the same user. */
  token: string;
}

export async function requireUser(req: Request): Promise<AuthUser> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  const token = match[1];
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      algorithms: ['EdDSA', 'ES256', 'RS256'],
      clockTolerance: 30,
    });
    const aud = payload.aud === undefined ? [] : Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (aud.length > 0 && !aud.includes(issuer)) throw new Error('audience mismatch');
    if (!payload.sub) throw new Error('missing sub');
    return {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      token,
    };
  } catch {
    throw new HttpError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
  }
}
