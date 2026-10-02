// Sign-up / login / logout against the real server (no LLM needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receiptbox-auth-'));
const port = 43000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${port}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), LLM_API_KEY: 'k', LLM_URL: 'http://localhost:1/none', LOG_LEVEL: 'error', LOGIN_MAX_FAILURES: '3' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];
const ALICE = { name: 'Alice', email: 'Alice@Example.com', password: 'correct horse battery' };

test('sign-up validates input', async () => {
  assert.equal((await post('/auth/signup', { ...ALICE, email: 'nope' })).status, 400);
  assert.equal((await post('/auth/signup', { ...ALICE, password: 'short' })).status, 400);
  assert.equal((await post('/auth/signup', { ...ALICE, name: '' })).status, 400);
});

test('sign-up creates an account and a session', async () => {
  const res = await post('/auth/signup', ALICE);
  assert.equal(res.status, 201);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.equal((await res.json()).user.email, 'alice@example.com');
  const me = await fetch(`${BASE}/auth/me`, { headers: { cookie: cookieOf(res) } });
  assert.equal((await me.json()).user.name, 'Alice');
});

test('the same email cannot sign up twice (case-insensitive)', async () => {
  assert.equal((await post('/auth/signup', { ...ALICE, email: 'ALICE@example.com' })).status, 409);
});

test('login, use the session, log out', async () => {
  const login = await post('/auth/login', { email: 'alice@example.com', password: ALICE.password });
  assert.equal(login.status, 200);
  const cookie = cookieOf(login);
  assert.equal((await fetch(`${BASE}/documents`, { headers: { cookie } })).status, 200);

  const logout = await post('/auth/logout', {}, { cookie });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${BASE}/documents`, { headers: { cookie } })).status, 401, 'session is gone server-side');
});

test('wrong password and unknown email give the same answer', async () => {
  const wrong = await post('/auth/login', { email: 'alice@example.com', password: 'wrong password!' });
  const unknown = await post('/auth/login', { email: 'nobody@example.com', password: 'wrong password!' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

test('cookie-authenticated writes from another site are blocked', async () => {
  const cookie = cookieOf(await post('/auth/login', { email: 'alice@example.com', password: ALICE.password }));
  const res = await fetch(`${BASE}/documents?filename=x.txt`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: 'hi' });
  assert.equal(res.status, 403);
  const ok = await fetch(`${BASE}/documents?filename=x.txt`, { method: 'POST', headers: { cookie, origin: BASE }, body: 'hi' });
  assert.equal(ok.status, 201);
});

test('repeated failed logins are rate limited', async () => {
  await post('/auth/signup', { name: 'Bob', email: 'bob@example.com', password: 'bob password 1' });
  for (let i = 0; i < 3; i++) await post('/auth/login', { email: 'bob@example.com', password: 'guess ' + i + '!!!!' });
  const blocked = await post('/auth/login', { email: 'bob@example.com', password: 'bob password 1' });
  assert.equal(blocked.status, 429, 'even the right password is refused while locked');
});
