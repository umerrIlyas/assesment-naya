import crypto from 'node:crypto';
import { promisify } from 'node:util';
import config from './config.js';
import * as db from './db.js';

// Two ways to authenticate:
//  - Browser: email + password sign-up/login, then a session cookie
//    (HttpOnly, SameSite=Lax, Secure in production). Sessions are stored
//    server-side so logout really ends them.
//  - Scripts/API: "Authorization: Bearer <token>" (npm run create-user).
// Only hashes of tokens, session ids and passwords are stored.

const scrypt = promisify(crypto.scrypt);
export const SESSION_COOKIE = 'rb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const randomToken = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

// ---- passwords -------------------------------------------------------------

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

// Verified against when the email doesn't exist, so a login takes the same
// time whether or not the account exists.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

// ---- accounts ----------------------------------------------------------------

export const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Validate sign-up input. Returns a message for the user, or null if valid. */
export function signupProblem({ email, password, name }) {
  if (!EMAIL_RE.test(email) || email.length > 254) return 'Enter a valid email address';
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 200) return 'Password must be at most 200 characters';
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return 'Enter your name (up to 100 characters)';
  return null;
}

export async function signUp({ email, password, name }) {
  email = normaliseEmail(email);
  const problem = signupProblem({ email, password, name });
  if (problem) throw new AuthError(400, problem);
  if (db.findUserByEmail(email)) throw new AuthError(409, 'An account with this email already exists. Log in instead.');
  try {
    // Accounts also get an API token hash (unused until one is issued) to keep token_hash unique and non-null.
    return db.createUser({
      id: crypto.randomUUID(),
      name: name.trim(),
      email,
      passwordHash: await hashPassword(password),
      tokenHash: hashToken(randomToken('rb_')),
    });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new AuthError(409, 'An account with this email already exists. Log in instead.');
    throw err;
  }
}

/** Returns the user, or null for a wrong email or password (deliberately indistinguishable). */
export async function logIn({ email, password }) {
  const user = db.findUserByEmail(normaliseEmail(email));
  const ok = await verifyPassword(String(password ?? ''), user?.passwordHash ?? DUMMY_HASH);
  return ok && user ? { id: user.id, name: user.name, email: user.email } : null;
}

// ---- login rate limiting -------------------------------------------------------
// Per email and per IP, so one attacker can't guess many passwords for one
// account, nor spray one password across many accounts. In memory (single
// process); see NOTES.md.

const failures = new Map(); // key -> timestamps of recent failures
const WINDOW_MS = 15 * 60 * 1000;

function recent(key) {
  const list = (failures.get(key) ?? []).filter((t) => Date.now() - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

export function loginBlocked(ip, email) {
  return recent(`email:${normaliseEmail(email)}`).length >= config.loginMaxFailures || recent(`ip:${ip}`).length >= config.loginMaxFailures * 5;
}

export function recordLoginFailure(ip, email) {
  for (const key of [`email:${normaliseEmail(email)}`, `ip:${ip}`]) failures.set(key, [...recent(key), Date.now()]);
  if (failures.size > 100_000) failures.delete(failures.keys().next().value);
}

export function clearLoginFailures(email) {
  failures.delete(`email:${normaliseEmail(email)}`);
}

// ---- sessions --------------------------------------------------------------------

export function startSession(userId) {
  const token = randomToken('');
  db.createSession({ tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  return token;
}

export function endSession(token) {
  if (token) db.deleteSession(hashToken(token));
}

export function sessionCookie(token) {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (config.secureCookies) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? '; Secure' : ''}`;
}

export function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// ---- API tokens ------------------------------------------------------------------

export function generateToken() {
  return randomToken('rb_');
}

export function createUser(name) {
  const token = generateToken();
  const user = db.createUser({ id: crypto.randomUUID(), name, tokenHash: hashToken(token) });
  return { user, token };
}

/**
 * The user making this request: bearer token first, then session cookie.
 * Returns { user, via } or null.
 */
export function authenticate(req) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (bearer) {
    const user = db.findUserByTokenHash(hashToken(bearer[1]));
    return user ? { user, via: 'token' } : null;
  }
  const session = readCookie(req, SESSION_COOKIE);
  if (session) {
    const user = db.findUserBySession(hashToken(session));
    return user ? { user, via: 'session' } : null;
  }
  return null;
}
