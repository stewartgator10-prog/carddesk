// netlify/lib/secret-box.js
// Seals marketplace tokens before they are stored, so a copy of the database alone can't use them.
// AES-256-GCM; the key is MARKETPLACE_TOKEN_KEY (32 random bytes, base64), set to the SAME value on
// both Netlify sites because they share one database.
//   seal(text)   -> 'v1.<iv>.<tag>.<ciphertext>' (base64url parts)
//   open(sealed) -> text; throws when the key is wrong or the value was changed
// Error messages never include the text or the sealed value.
import crypto from 'node:crypto';

const VERSION = 'v1';

export class SecretBoxError extends Error {
  constructor(message, code) { super(message); this.name = 'SecretBoxError'; this.code = code; }
}

export function boxKey(env = process.env) {
  const raw = env.MARKETPLACE_TOKEN_KEY;
  if (!raw) throw new SecretBoxError('MARKETPLACE_TOKEN_KEY is not set on this site.', 'NO_KEY');
  const key = Buffer.from(String(raw).trim(), 'base64');
  if (key.length !== 32) throw new SecretBoxError('MARKETPLACE_TOKEN_KEY must be 32 random bytes, base64 encoded.', 'BAD_KEY');
  return key;
}

export const hasBoxKey = (env = process.env) => { try { boxKey(env); return true; } catch { return false; } };

export function seal(text, key = boxKey()) {
  if (typeof text !== 'string' || !text) throw new SecretBoxError('Nothing to seal.', 'EMPTY');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed, key = boxKey()) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError('The stored token is not in a format this site can read.', 'FORMAT');
  try {
    const [, iv, tag, body] = parts.map((p, i) => (i ? Buffer.from(p, 'base64url') : p));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError('The stored token could not be opened (wrong MARKETPLACE_TOKEN_KEY, or it was changed).', 'OPEN_FAILED');
  }
}
