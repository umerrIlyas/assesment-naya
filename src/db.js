import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

// SQLite via Node's built-in driver (no native dependency). WAL mode lets the
// HTTP handlers read while the worker writes, and every write is a small,
// atomic statement instead of rewriting one big JSON file.
//
// Money is stored as integer minor units (cents) to avoid float drift.

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  filename         TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  page_count       INTEGER,
  pages_processed  INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_user ON documents(user_id, created_at);
CREATE INDEX IF NOT EXISTS documents_queue ON documents(status, created_at);

CREATE TABLE IF NOT EXISTS pages (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number  INTEGER NOT NULL,          -- position in the scan, 1-based
  text         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'needs_review', 'failed')),
  merchant     TEXT,
  date         TEXT,
  total_cents  INTEGER,
  currency     TEXT,
  category     TEXT,
  confidence   REAL,
  issues       TEXT NOT NULL DEFAULT '[]', -- JSON array of human-readable reasons
  PRIMARY KEY (document_id, page_number)
);
`;

export function open(dbPath = config.dbPath) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function close() {
  db?.close();
  db = undefined;
}

const now = () => new Date().toISOString();

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- users -----------------------------------------------------------------

export function createUser({ id, name, tokenHash }) {
  db.prepare('INSERT INTO users (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, tokenHash, now());
  return { id, name };
}

export function findUserByTokenHash(tokenHash) {
  return db.prepare('SELECT id, name FROM users WHERE token_hash = ?').get(tokenHash);
}

// ---- documents -------------------------------------------------------------

const DOC_COLUMNS = `d.id, d.user_id AS userId, d.filename, d.status, d.page_count AS pageCount,
  d.pages_processed AS pagesProcessed, d.error, d.created_at AS createdAt, d.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM pages p WHERE p.document_id = d.id AND p.status = 'needs_review') AS needsReview,
  (SELECT COUNT(*) FROM pages p WHERE p.document_id = d.id AND p.status = 'failed') AS failedPages`;

export function insertDocument({ id, userId, filename, filePath }) {
  const ts = now();
  db.prepare(
    `INSERT INTO documents (id, user_id, filename, file_path, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, userId, filename, filePath, ts, ts);
  return getDocument(userId, id);
}

export function listDocuments(userId) {
  return db.prepare(`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.user_id = ? ORDER BY d.created_at DESC`).all(userId);
}

export function getDocument(userId, id) {
  return db.prepare(`SELECT ${DOC_COLUMNS} FROM documents d WHERE d.user_id = ? AND d.id = ?`).get(userId, id);
}

/** Re-queue a finished document. Returns false if it is still being processed. */
export function requeueDocument(userId, id) {
  return tx(() => {
    const doc = db.prepare('SELECT status FROM documents WHERE id = ? AND user_id = ?').get(id, userId);
    if (!doc) return null;
    if (doc.status === 'pending' || doc.status === 'processing') return false;
    db.prepare('DELETE FROM pages WHERE document_id = ?').run(id);
    db.prepare(
      `UPDATE documents SET status = 'pending', page_count = NULL, pages_processed = 0, error = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now(), id);
    return true;
  });
}

// ---- job queue (the documents table is the queue) ---------------------------

/** Atomically claim the oldest pending document. */
export function claimNextDocument() {
  return db
    .prepare(
      `UPDATE documents SET status = 'processing', updated_at = ?
       WHERE id = (SELECT id FROM documents WHERE status = 'pending' ORDER BY created_at LIMIT 1)
       RETURNING id, user_id AS userId, file_path AS filePath`,
    )
    .get(now());
}

/** After a crash or restart, anything that was mid-flight goes back in the queue. */
export function requeueInterrupted() {
  return db.prepare(`UPDATE documents SET status = 'pending', updated_at = ? WHERE status = 'processing'`).run(now()).changes;
}

export function setPageCount(id, pageCount) {
  db.prepare('UPDATE documents SET page_count = ?, updated_at = ? WHERE id = ?').run(pageCount, now(), id);
}

export function finishDocument(id, { status, error = null }) {
  db.prepare('UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, now(), id);
}

// ---- pages -----------------------------------------------------------------

export function processedPageNumbers(documentId) {
  return new Set(db.prepare('SELECT page_number FROM pages WHERE document_id = ?').all(documentId).map((r) => r.page_number));
}

/** Save one extracted page and bump the document's progress in one transaction. */
export function savePage(documentId, page) {
  tx(() => {
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO pages
           (document_id, page_number, text, status, merchant, date, total_cents, currency, category, confidence, issues)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        page.pageNumber,
        page.text,
        page.status,
        page.merchant ?? null,
        page.date ?? null,
        page.totalCents ?? null,
        page.currency ?? null,
        page.category ?? null,
        page.confidence ?? null,
        JSON.stringify(page.issues ?? []),
      );
    if (inserted.changes) {
      db.prepare('UPDATE documents SET pages_processed = pages_processed + 1, updated_at = ? WHERE id = ?').run(now(), documentId);
    }
  });
}

const PAGE_COLUMNS = `p.document_id AS documentId, d.filename, p.page_number AS pageNumber, p.status, p.merchant, p.date,
  p.total_cents AS totalCents, p.currency, p.category, p.confidence, p.issues`;

const hydrate = (row) => row && { ...row, issues: JSON.parse(row.issues) };

export function listPages(userId, documentId) {
  return db
    .prepare(
      `SELECT ${PAGE_COLUMNS}, p.text FROM pages p JOIN documents d ON d.id = p.document_id
       WHERE d.user_id = ? AND p.document_id = ? ORDER BY p.page_number`,
    )
    .all(userId, documentId)
    .map(hydrate);
}

/** Expense report lines for a user, optionally filtered. Text search is case-insensitive. */
export function searchLines(userId, { q, category, limit = 1000 } = {}) {
  const where = ['d.user_id = ?'];
  const args = [userId];
  if (category) {
    where.push('p.category = ?');
    args.push(category);
  }
  if (q) {
    where.push(`(p.text LIKE ? ESCAPE '\\' OR p.merchant LIKE ? ESCAPE '\\')`);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    args.push(like, like);
  }
  args.push(limit);
  return db
    .prepare(
      `SELECT ${PAGE_COLUMNS}, substr(p.text, 1, 200) AS snippet FROM pages p JOIN documents d ON d.id = p.document_id
       WHERE ${where.join(' AND ')} ORDER BY p.date IS NULL, p.date, d.created_at, p.page_number LIMIT ?`,
    )
    .all(...args)
    .map(hydrate);
}

export function ping() {
  return db.prepare('SELECT 1 AS ok').get().ok === 1;
}
