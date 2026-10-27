/*
 * The session cookie: what it carries, sealed, and how it is read and written.
 *
 * Sealed with AES-256-GCM under the session's own key (derived for that one
 * purpose, see ../crypto/key-derivation.ts): a twelve-byte IV, the sixteen-byte
 * tag, then the ciphertext, as base64url. A value that does not open -- forged,
 * truncated, sealed under another key, or not JSON -- reads as no value, never
 * as an error, so a bad cookie is simply a signed-out request.
 *
 * With a database the cookie carries only the session's id and the session is
 * kept there; without one it carries the session itself, bounded by the local
 * session policy (local-session-policy.ts).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'nv_session';
/* Thirty days, the cookie's lifetime when the caller names none. */
export const SESSION_COOKIE_MAX_AGE = 2592000;

export interface SessionSeal {
  seal(value: unknown): string;
  /* The value, or null when it does not open. */
  unseal(text: string): unknown;
}

export function createSessionSeal(key: Buffer): SessionSeal {
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
    },
    unseal(text) {
      try {
        const raw = Buffer.from(text, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
      } catch { return null; }
    }
  };
}

interface CookieRequest {
  readonly headers: { readonly cookie?: string | undefined };
}

/* A cookie's value as the request sent it, or null. The first of a repeated name wins. */
export function readCookie(req: CookieRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

interface CookieResponse {
  setHeader(name: string, value: string): unknown;
}

/*
 * Writes the session cookie: HTTP-only, same-site Lax, the whole site, and
 * Secure in production. A max age of 0 ends it. Whether this is production is
 * asked on every write, as it always was.
 */
export function createSessionCookieWriter(production: () => boolean) {
  return function writeSessionCookie(res: CookieResponse, value: string, maxAge: number = SESSION_COOKIE_MAX_AGE): void {
    const secure = production() ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
  };
}
