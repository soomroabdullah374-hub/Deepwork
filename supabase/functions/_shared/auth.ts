// Verifies the Neon Auth (Managed Better Auth) JWT the app sends on every request.
// Keys come from Neon Auth's JWKS and are cached by jose for the life of the isolate.

import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from 'npm:jose@5.9.6';
import { config } from './env.ts';
import { HttpError } from './http.ts';

const jwksUrl = new URL(`${config.neonAuthUrl}/.well-known/jwks.json`);
const issuer = new URL(config.neonAuthUrl).origin;
const newKeySet = () => createRemoteJWKSet(jwksUrl, { cacheMaxAge: 10 * 60_000, cooldownDuration: 0, timeoutDuration: 8_000 });
let jwks = newKeySet();

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  /** The raw JWT, forwarded to the Neon Data API so RLS sees the same user. */
  token: string;
}

async function verify(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ['EdDSA', 'ES256', 'RS256'], clockTolerance: 30 });
  return payload;
}

// Errors that say something about the token itself; anything else (fetching or reading
// the key set) is worth one more try with a fresh key set.
const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWSSignatureVerificationFailed,
  errors.JWSInvalid,
  errors.JWTInvalid,
];

export async function requireUser(req: Request): Promise<AuthUser> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  const token = match[1];
  let payload: JWTPayload;
  try {
    try {
      payload = await verify(token);
    } catch (err) {
      if (TOKEN_ERRORS.some((E) => err instanceof E)) throw err;
      console.warn('jwt verify retry', (err as { code?: string }).code ?? (err as Error).name, (err as Error).message);
      jwks = newKeySet();
      payload = await verify(token);
    }
  } catch (err) {
    console.warn('jwt rejected', (err as { code?: string }).code ?? (err as Error).name, (err as Error).message);
    throw new HttpError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
  }
  const aud = payload.aud === undefined ? [] : Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((aud.length > 0 && !aud.includes(issuer)) || !payload.sub) {
    console.warn('jwt rejected', 'claims', JSON.stringify({ aud, sub: Boolean(payload.sub) }));
    throw new HttpError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
  }
  return {
    id: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    token,
  };
}
