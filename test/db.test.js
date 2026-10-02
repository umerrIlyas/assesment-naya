import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test file gets its own throwaway database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receiptbox-db-'));
process.env.DATA_DIR = dir;
const db = await import('../src/db.js');

before(() => {
  db.open();
  db.createUser({ id: 'alice', name: 'Alice', tokenHash: 'a' });
  db.createUser({ id: 'bob', name: 'Bob', tokenHash: 'b' });
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const page = (n) => ({ pageNumber: n, text: `receipt ${n}`, status: 'ok', merchant: 'Lumen', totalCents: 800, currency: 'USD', category: 'meals', issues: [] });

test('queue: claim, save pages idempotently, finish', () => {
  db.insertDocument({ id: 'd1', userId: 'alice', filename: 'a.txt', filePath: '/x' });
  const job = db.claimNextDocument();
  assert.equal(job.id, 'd1');
  assert.equal(db.claimNextDocument(), undefined, 'a claimed document is not handed out twice');
  db.setPageCount('d1', 2);
  db.savePage('d1', page(1));
  db.savePage('d1', page(1)); // e.g. resumed after a crash
  db.savePage('d1', page(2));
  db.finishDocument('d1', { status: 'done' });
  const doc = db.getDocument('alice', 'd1');
  assert.equal(doc.pagesProcessed, 2);
  assert.equal(db.listPages('alice', 'd1').length, 2);
});

test('retry clears old lines instead of duplicating them', () => {
  assert.equal(db.requeueDocument('alice', 'd1'), true);
  assert.equal(db.listPages('alice', 'd1').length, 0);
  assert.equal(db.requeueDocument('alice', 'd1'), false, 'cannot retry while pending');
  assert.equal(db.requeueDocument('alice', 'missing'), null);
});

test('interrupted documents go back in the queue', () => {
  db.claimNextDocument();
  assert.equal(db.requeueInterrupted(), 1);
  assert.equal(db.getDocument('alice', 'd1').status, 'pending');
});

test('users only see their own documents and lines', () => {
  db.savePage('d1', page(1));
  assert.equal(db.getDocument('bob', 'd1'), undefined);
  assert.equal(db.listDocuments('bob').length, 0);
  assert.equal(db.searchLines('bob').length, 0);
  assert.equal(db.searchLines('alice').length, 1);
  assert.equal(db.requeueDocument('bob', 'd1'), null);
});

test('search combines text and category, and escapes LIKE wildcards', () => {
  assert.equal(db.searchLines('alice', { q: 'LUMEN', category: 'meals' }).length, 1);
  assert.equal(db.searchLines('alice', { q: 'lumen', category: 'travel' }).length, 0);
  assert.equal(db.searchLines('alice', { q: '%' }).length, 0);
});
