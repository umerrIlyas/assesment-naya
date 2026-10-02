import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import config, { assertConfig } from './config.js';
import * as db from './db.js';
import { notify, startWorker, stopWorker } from './worker.js';
import { ask, SUGGESTED } from './assistant.js';
import { authenticate } from './auth.js';
import { log } from './log.js';
import { toPublicDocument, toPublicLine, CATEGORIES } from './views.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

/** Display name only: never used to build a path on disk. */
function cleanFilename(raw) {
  const name = path.basename(String(raw || '')).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name || 'untitled.txt';
}

/**
 * Stream the upload to disk (never buffer it in memory), enforcing the size and
 * page limits as bytes arrive. The file is stored under a server-generated id.
 */
async function storeUpload(req, id) {
  const declared = Number(req.headers['content-length']);
  if (declared > config.maxUploadBytes) throw new HttpError(413, `File is too large (limit ${config.maxUploadBytes} bytes)`);

  const finalPath = path.join(config.uploadDir, `${id}.txt`);
  const partPath = `${finalPath}.part`;
  let bytes = 0;
  let pages = 1;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      for (const b of chunk) if (b === 0x0c) pages++;
      if (bytes > config.maxUploadBytes) return cb(new HttpError(413, `File is too large (limit ${config.maxUploadBytes} bytes)`));
      if (pages > config.maxPages) return cb(new HttpError(413, `Too many pages (limit ${config.maxPages}). Split the scan into smaller files.`));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(partPath));
  } catch (err) {
    fs.rmSync(partPath, { force: true });
    throw err instanceof HttpError ? err : new HttpError(400, 'Upload was interrupted');
  }
  if (bytes === 0) {
    fs.rmSync(partPath, { force: true });
    throw new HttpError(400, 'The file is empty');
  }
  fs.renameSync(partPath, finalPath);
  return finalPath;
}

// ---- routes ------------------------------------------------------------------

const indexHtml = fs.readFileSync('./public/index.html');
const SAMPLES = new Set(['weekend-trip.txt', 'sales-quarter.txt', 'conference-trip.txt']);

const routes = [
  ['GET', /^\/$/, { public: true }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    res.end(indexHtml);
  }],

  ['GET', /^\/health$/, { public: true }, (req, res) => {
    send(res, 200, { ok: db.ping() });
  }],

  // Lets the UI upload the generated sample files.
  ['GET', /^\/samples\/([^/]+)$/, { public: true }, (req, res, [name]) => {
    if (!SAMPLES.has(name)) throw new HttpError(404, 'not found');
    const samplePath = path.join('./samples', name);
    if (!fs.existsSync(samplePath)) throw new HttpError(404, 'run "npm run samples" first');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    fs.createReadStream(samplePath).pipe(res);
  }],

  // POST /documents?filename=foo.txt   (raw body = scan text, pages separated by \f)
  ['POST', /^\/documents$/, {}, async (req, res, _params, { user, url }) => {
    const id = crypto.randomUUID();
    const filePath = await storeUpload(req, id);
    const doc = db.insertDocument({ id, userId: user.id, filename: cleanFilename(url.searchParams.get('filename')), filePath });
    notify();
    log.info('document uploaded', { documentId: id, userId: user.id });
    send(res, 201, toPublicDocument(doc));
  }],

  ['GET', /^\/documents$/, {}, (req, res, _params, { user }) => {
    send(res, 200, db.listDocuments(user.id).map(toPublicDocument));
  }],

  ['GET', /^\/documents\/([^/]+)$/, {}, (req, res, [id], { user }) => {
    const doc = db.getDocument(user.id, id);
    if (!doc) throw new HttpError(404, 'not found');
    send(res, 200, { ...toPublicDocument(doc), pages: db.listPages(user.id, id).map((p) => ({ ...toPublicLine(p), text: p.text })) });
  }],

  ['POST', /^\/documents\/([^/]+)\/retry$/, {}, (req, res, [id], { user }) => {
    const result = db.requeueDocument(user.id, id);
    if (result === null) throw new HttpError(404, 'not found');
    if (result === false) throw new HttpError(409, 'This scan is still being processed');
    notify();
    send(res, 202, { id, status: 'pending' });
  }],

  // GET /search?q=lumen&category=meals   (both filters combine)
  ['GET', /^\/search$/, {}, (req, res, _params, { user, url }) => {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200) || undefined;
    const category = url.searchParams.get('category') || undefined;
    if (category && !CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of ${CATEGORIES.join(', ')}`);
    send(res, 200, db.searchLines(user.id, { q, category }).map(toPublicLine));
  }],

  ['GET', /^\/questions$/, { public: true }, (req, res) => {
    send(res, 200, Object.keys(SUGGESTED));
  }],

  // POST /ask   {"question": "..."}
  ['POST', /^\/ask$/, {}, async (req, res, _params, { user }) => {
    const body = await readJson(req);
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > 500) throw new HttpError(400, 'question must be a non-empty string of at most 500 characters');
    send(res, 200, await ask(user, question));
  }],
];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  for (const [method, pattern, opts, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (!match) continue;
    if (req.method !== method) continue;
    const user = opts.public ? null : authenticate(req);
    if (!opts.public && !user) throw new HttpError(401, 'Missing or invalid API token');
    let params;
    try {
      params = match.slice(1).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }
    return handler(req, res, params, { user, url });
  }
  throw new HttpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => log.info('request', { method: req.method, path: req.url.split('?')[0], status: res.statusCode, ms: Date.now() - started }));
  try {
    await handle(req, res);
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message });
    } else {
      log.error('unhandled request error', { method: req.method, path: req.url.split('?')[0], error: err.message, stack: err.stack });
      if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
      else res.destroy();
    }
  }
});

// ---- lifecycle ---------------------------------------------------------------

assertConfig();
fs.mkdirSync(config.uploadDir, { recursive: true });
db.open();
startWorker();
server.listen(config.port, () => log.info('receiptbox listening', { url: `http://localhost:${config.port}` }));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  server.close();
  await stopWorker();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String(err?.message || err) }));
