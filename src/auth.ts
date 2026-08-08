/**
 * Magic-link auth and signed sessions.
 *
 * Passwords are deliberately absent, and not for fashion: password resets are the
 * single largest support burden in a small SaaS, and a product that must survive on
 * ten minutes of maintenance a week cannot afford an inbox. No passwords means no
 * resets, no credential stuffing, and nothing worth stealing from the database.
 *
 * Sessions are HMAC-signed cookies rather than rows in a table. One less query on
 * every request, and one less thing to garbage-collect — the trade is that a session
 * cannot be revoked before it expires, which is why they are short-lived.
 */

import { sha256Hex } from './snapshot.ts';

const SESSION_TTL_HOURS = 24 * 14;
const MAGIC_LINK_TTL_MINUTES = 15;

export interface Session {
  workspaceId: string;
  email: string;
  expiresAt: number;
}

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function issueSession(session: Omit<Session, 'expiresAt'>, secret: string, now = new Date()): Promise<string> {
  const payload: Session = { ...session, expiresAt: now.getTime() + SESSION_TTL_HOURS * 3_600_000 };
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const signature = await globalThis.crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `v1.${body}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Verification uses `subtle.verify` rather than comparing strings — the comparison is
 * constant-time inside WebCrypto, so there is no hand-rolled equality check here to
 * get subtly wrong.
 */
export async function verifySession(cookie: string | null, secret: string, now = new Date()): Promise<Session | null> {
  if (!cookie) return null;
  const [version, body, signature] = cookie.split('.');
  if (version !== 'v1' || !body || !signature) return null;

  try {
    const valid = await globalThis.crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromB64url(signature),
      encoder.encode(body),
    );
    if (!valid) return null;

    const session = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    // Signature valid but expired is still a rejection: the signature only proves we
    // issued it, never that it is still good.
    return session.expiresAt > now.getTime() ? session : null;
  } catch {
    return null;
  }
}

export function sessionCookie(value: string, secure = true): string {
  return [
    `dl_session=${value}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: a magic link is a cross-site navigation into the app, and Strict
    // would drop the cookie on exactly that first hop. Lax still withholds it from
    // cross-site POSTs, which is the case that matters — see requireSameOrigin.
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_HOURS * 3600}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export const clearedSessionCookie = 'dl_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// ── magic links ─────────────────────────────────────────────────────────────────

export interface MagicLink {
  token: string;
  tokenHash: string;
  expiresAt: string;
}

/**
 * 32 bytes of CSPRNG. Only the hash is stored, so a database leak yields nothing that
 * can be redeemed — the same reasoning as the API token in the export route.
 */
export async function createMagicLink(now = new Date()): Promise<MagicLink> {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const token = b64url(bytes);
  return {
    token,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MINUTES * 60_000).toISOString(),
  };
}

export const hashMagicToken = (token: string) => sha256Hex(token);

/**
 * Rejects a cross-site form post.
 *
 * `SameSite=Lax` already withholds the session cookie from cross-site POSTs, so this
 * is the second lock rather than the first — cheap, and it does not depend on every
 * browser in the wild implementing SameSite the way we hope.
 */
export function requireSameOrigin(request: Request, appBaseUrl: string): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false; // browsers always send Origin on POST
  try {
    return new URL(origin).origin === new URL(appBaseUrl).origin;
  } catch {
    return false;
  }
}
