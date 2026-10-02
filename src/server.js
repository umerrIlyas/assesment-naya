import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config, { assertConfig } from './config.js';
import * as db from './db.js';
import { enqueue, startWorker } from './worker.js';
import { ask, SUGGESTED } from './assistant.js';

assertConfig();
fs.mkdirSync(config.uploadDir, { recursive: true });

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  console.log(req.method, url.pathname);

  // GET /   (the UI)
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync('./public/index.html'));
  }

  // GET /samples/:name   (lets the UI upload the generated sample files)
  const SAMPLES = ['weekend-trip.txt', 'sales-quarter.txt', 'conference-trip.txt'];
  if (req.method === 'GET' && parts[0] === 'samples' && SAMPLES.includes(parts[1])) {
    const samplePath = `./samples/${parts[1]}`;
    if (!fs.existsSync(samplePath)) return send(res, 404, { error: 'run "npm run samples" first' });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(fs.readFileSync(samplePath));
  }

  // POST /documents?filename=foo.txt   (raw body = document text, pages separated by \f)
  if (req.method === 'POST' && url.pathname === '/documents') {
    const body = await readBody(req);
    const id = crypto.randomUUID();
    const filename = url.searchParams.get('filename') || 'untitled.txt';
    const filePath = path.join(config.uploadDir, filename);
    fs.writeFileSync(filePath, body);

    const data = db.load();
    data.documents[id] = {
      id,
      filename,
      filePath,
      status: 'pending',
      pages: [],
      createdAt: new Date().toISOString(),
    };
    db.save(data);
    enqueue(id);
    return send(res, 201, data.documents[id]);
  }

  // GET /documents
  if (req.method === 'GET' && url.pathname === '/documents') {
    const data = db.load();
    const docs = Object.values(data.documents).map((d) => ({
      id: d.id,
      filename: d.filename,
      status: d.status,
      progress: d.progress,
      pageCount: d.pages.length,
      error: d.error,
      createdAt: d.createdAt,
    }));
    return send(res, 200, docs);
  }

  // GET /documents/:id
  if (req.method === 'GET' && parts[0] === 'documents' && parts.length === 2) {
    const data = db.load();
    const doc = data.documents[parts[1]];
    if (!doc) return send(res, 404, { error: 'not found' });
    return send(res, 200, doc);
  }

  // POST /documents/:id/retry
  if (req.method === 'POST' && parts[0] === 'documents' && parts[2] === 'retry') {
    const data = db.load();
    const doc = data.documents[parts[1]];
    doc.status = 'pending';
    db.save(data);
    enqueue(doc.id);
    return send(res, 202, { id: doc.id, status: doc.status });
  }

  // GET /search?q=lumen&category=meals
  if (req.method === 'GET' && url.pathname === '/search') {
    const q = url.searchParams.get('q');
    const category = url.searchParams.get('category');
    const data = db.load();
    const results = [];
    for (const doc of Object.values(data.documents)) {
      for (const page of doc.pages) {
        const matches = category ? page.category === category : !q || page.text.includes(q);
        if (!matches) continue;
        results.push({
          documentId: doc.id,
          filename: doc.filename,
          pageNumber: page.pageNumber,
          category: page.category,
          merchant: page.merchant,
          date: page.date,
          total: page.total,
          currency: page.currency,
          snippet: page.text.slice(0, 200),
        });
      }
    }
    return send(res, 200, results);
  }

  // GET /questions   (suggested questions for the assistant)
  if (req.method === 'GET' && url.pathname === '/questions') {
    return send(res, 200, Object.keys(SUGGESTED));
  }

  // POST /ask   {"question": "..."}
  if (req.method === 'POST' && url.pathname === '/ask') {
    const { question } = JSON.parse(await readBody(req));
    const result = await ask(question);
    return send(res, 200, result);
  }

  send(res, 404, { error: 'not found' });
});

startWorker();
server.listen(config.port, () => {
  console.log(`receiptbox listening on http://localhost:${config.port}`);
});
