import crypto from 'node:crypto';
import * as db from './db.js';

// Per-user API tokens. Only a SHA-256 hash is stored: tokens are 256-bit random
// values, so a fast hash is sufficient and lookup by hash avoids timing leaks.
// This is the minimum for isolating customers' data; SSO is the next step
// (see NOTES.md).

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function generateToken() {
  return `rb_${crypto.randomBytes(32).toString('base64url')}`;
}

export function createUser(name) {
  const token = generateToken();
  const user = db.createUser({ id: crypto.randomUUID(), name, tokenHash: hashToken(token) });
  return { user, token };
}

/** The user for a request's "Authorization: Bearer <token>" header, or null. */
export function authenticate(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return null;
  return db.findUserByTokenHash(hashToken(match[1])) ?? null;
}
