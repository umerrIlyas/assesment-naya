// End to end: the real server against the vendor sandbox (seeded, with its
// default fault injection on), using the three sample scans.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receiptbox-e2e-'));
const sandboxPort = 41000 + Math.floor(Math.random() * 1000);
const port = sandboxPort + 1000;
const BASE = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  SANDBOX_PORT: String(sandboxPort),
  SANDBOX_SEED: '1234',
  LLM_URL: `http://localhost:${sandboxPort}/v1/messages`,
  LLM_API_KEY: 'test-key',
  LLM_TIMEOUT_MS: '20000',
  LOG_LEVEL: 'error',
};
const procs = [];
let alice, bob;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (token, p, opts = {}) => fetch(BASE + p, { ...opts, headers: { ...opts.headers, ...(token && { authorization: `Bearer ${token}` }) } });
const json = async (res) => ({ status: res.status, body: await res.json() });

function createUser(name) {
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-user.js', name], { cwd: ROOT, env }).toString();
  return out.match(/token: (\S+)/)[1];
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error('timed out');
}

async function upload(token, name, filename = name) {
  return json(await call(token, `/documents?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: fs.readFileSync(path.join(ROOT, 'samples', name)) }));
}

async function waitForDocs(token, ids) {
  await waitFor(async () => {
    const docs = (await json(await call(token, '/documents'))).body;
    return ids.every((id) => ['done', 'failed'].includes(docs.find((d) => d.id === id)?.status));
  }, 240_000);
}

before(async () => {
  execFileSync(process.execPath, ['scripts/make-samples.js'], { cwd: ROOT });
  alice = createUser('Alice');
  bob = createUser('Bob');
  procs.push(spawn(process.execPath, ['vendor/llm-sandbox/server.js'], { cwd: ROOT, env, stdio: 'ignore' }));
  procs.push(spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }));
  await waitFor(() => fetch(`${BASE}/health`).then((r) => r.ok, () => false), 10_000);
});

after(() => {
  for (const p of procs) p.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rejects requests without a valid token', async () => {
  assert.equal((await call(null, '/documents')).status, 401);
  assert.equal((await call('rb_wrong', '/documents')).status, 401);
});

test('rejects bad input without crashing', async () => {
  assert.equal((await call(alice, '/ask', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await call(alice, '/documents', { method: 'POST', body: '' })).status, 400);
  assert.equal((await call(alice, '/documents/nope/retry', { method: 'POST' })).status, 404);
  assert.equal((await call(alice, '/search?category=bogus')).status, 400);
  const big = await call(alice, '/documents', { method: 'POST', body: Buffer.alloc(11 * 1024 * 1024, 'a') });
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${BASE}/health`)).status, 200);
});

test('a filename cannot write outside the uploads directory', async () => {
  const { status, body } = await upload(alice, 'weekend-trip.txt', '../../../escape.txt');
  assert.equal(status, 201);
  assert.equal(body.filename, 'escape.txt');
  assert.ok(!fs.existsSync(path.join(dataDir, '..', 'escape.txt')));
  await waitForDocs(alice, [body.id]);
});

test('processes the sample scans into a correct expense report', { timeout: 300_000 }, async () => {
  const weekend = (await upload(alice, 'weekend-trip.txt')).body;
  const quarter = (await upload(alice, 'sales-quarter.txt')).body;
  const conference = (await upload(alice, 'conference-trip.txt')).body;
  await waitForDocs(alice, [weekend.id, quarter.id, conference.id]);

  const get = async (id) => (await json(await call(alice, `/documents/${id}`))).body;
  const w = await get(weekend.id);
  const q = await get(quarter.id);
  const c = await get(conference.id);

  for (const doc of [w, q, c]) assert.equal(doc.status, 'done', `${doc.filename}: ${doc.error}`);
  assert.equal(w.pages.length, 5, 'blank page skipped');
  assert.deepEqual(w.pages.map((p) => p.pageNumber), [1, 2, 4, 5, 6], 'page numbers match the scan');
  assert.equal(q.pages.length, 72);
  assert.equal(c.pages.length, 30);

  const injected = q.pages.find((p) => p.pageNumber === 38);
  assert.equal(injected.status, 'needs_review');
  assert.ok(injected.issues.some((i) => /AI/.test(i)), injected.issues.join());

  const unreadable = c.pages.find((p) => p.pageNumber === 12);
  assert.notEqual(unreadable.status, 'ok');

  for (const p of [...w.pages, ...q.pages, ...c.pages]) {
    if (p.status !== 'ok') continue;
    assert.ok(Number.isInteger(p.totalCents) && p.totalCents > 0, `page ${p.pageNumber} total`);
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(p.currency, /^[A-Z]{3}$/);
    assert.ok(['meals', 'travel', 'lodging', 'office', 'software', 'other'].includes(p.category));
  }

  const { body: total } = await json(await call(alice, '/ask', { method: 'POST', body: JSON.stringify({ question: 'What is my total to reimburse?' }) }));
  assert.equal(total.source, 'report');
  assert.doesNotMatch(total.answer, /NaN|undefined/);
  assert.match(total.answer, /€/, 'EUR kept separate from USD');
  assert.doesNotMatch(total.answer, /1,840/);

  const { body: free } = await json(await call(alice, '/ask', { method: 'POST', body: JSON.stringify({ question: 'How much did I spend at Bistro Verde?' }) }));
  assert.equal(free.source, 'llm');
  assert.doesNotMatch(free.answer, /Note for AI|1,840/i, 'injected text is not echoed');
});

test('retry re-processes without duplicating lines, and is refused while running', async () => {
  const docs = (await json(await call(alice, '/documents'))).body;
  const weekend = docs.find((d) => d.filename === 'weekend-trip.txt');
  assert.equal((await call(alice, `/documents/${weekend.id}/retry`, { method: 'POST' })).status, 202);
  assert.equal((await call(alice, `/documents/${weekend.id}/retry`, { method: 'POST' })).status, 409);
  await waitForDocs(alice, [weekend.id]);
  const doc = (await json(await call(alice, `/documents/${weekend.id}`))).body;
  assert.equal(doc.pages.length, 5);
});

test("users cannot see each other's data", async () => {
  const aliceDocs = (await json(await call(alice, '/documents'))).body;
  assert.ok(aliceDocs.length > 0);
  assert.deepEqual((await json(await call(bob, '/documents'))).body, []);
  assert.deepEqual((await json(await call(bob, '/search'))).body, []);
  assert.equal((await call(bob, `/documents/${aliceDocs[0].id}`)).status, 404);
  assert.equal((await call(bob, `/documents/${aliceDocs[0].id}/retry`, { method: 'POST' })).status, 404);
  const { body } = await json(await call(bob, '/ask', { method: 'POST', body: JSON.stringify({ question: 'How many receipts have I uploaded?' }) }));
  assert.match(body.answer, /\*\*0\*\*/);
});
