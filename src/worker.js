import fs from 'node:fs/promises';
import config from './config.js';
import * as db from './db.js';
import { extractPage } from './extraction.js';
import { log } from './log.js';

// Background worker. The queue lives in the database (documents with status
// 'pending'), so nothing is lost on restart: documents that were mid-flight are
// put back in the queue on startup, and pages already saved are skipped.

let running = 0;
let stopping = false;
let timer;

export function startWorker() {
  const recovered = db.requeueInterrupted();
  if (recovered) log.info('requeued interrupted documents', { count: recovered });
  stopping = false;
  timer = setInterval(pump, 1000); // safety net; notify() is the fast path
  pump();
}

/** Wake the worker after enqueueing, instead of waiting for the next tick. */
export function notify() {
  setImmediate(pump);
}

/** Stop claiming new work and wait (bounded) for in-flight documents to pause. */
export async function stopWorker(timeoutMs = 10_000) {
  stopping = true;
  clearInterval(timer);
  const deadline = Date.now() + timeoutMs;
  while (running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

function pump() {
  while (!stopping && running < config.workerConcurrency) {
    const job = db.claimNextDocument();
    if (!job) return;
    running++;
    processDocument(job)
      .catch((err) => log.error('document processing crashed', { documentId: job.id, error: err.message }))
      .finally(() => {
        running--;
        if (!stopping) pump();
      });
  }
}

/** Split a scan into non-blank pages, keeping each page's position in the scan. */
export function splitPages(text) {
  return text
    .split('\f')
    .map((raw, i) => ({ pageNumber: i + 1, text: raw.trim() }))
    .filter((p) => p.text.length > 0);
}

async function processDocument(job) {
  const started = Date.now();
  try {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(job.filePath));
    } catch (err) {
      if (err.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw err;
      return db.finishDocument(job.id, { status: 'failed', error: 'This file is not a text scan from the scanning app.' });
    }
    const pages = splitPages(text);
    if (pages.length > config.maxPages) {
      return db.finishDocument(job.id, { status: 'failed', error: `This scan has ${pages.length} receipts; the limit is ${config.maxPages}. Split it into smaller files.` });
    }
    db.setPageCount(job.id, pages.length);

    // A few pages in flight per document, so one slow LLM call doesn't stall the
    // scan. The shared rate limiter in llm.js keeps the total request rate in check.
    const done = db.processedPageNumbers(job.id);
    const todo = pages.filter((p) => !done.has(p.pageNumber));
    const lane = async () => {
      while (todo.length && !stopping) {
        const page = todo.shift();
        const result = await extractPage(page.text);
        db.savePage(job.id, { pageNumber: page.pageNumber, text: page.text, ...result });
      }
    };
    await Promise.all(Array.from({ length: config.pageConcurrency }, lane));
    if (stopping) return; // left as 'processing'; requeued and resumed on next start

    db.finishDocument(job.id, { status: 'done' });
    log.info('document processed', { documentId: job.id, pages: pages.length, ms: Date.now() - started });
  } catch (err) {
    // Shown to the employee, so keep it generic; details go to the log.
    const error = err.code === 'ENOENT' ? 'The uploaded file is missing. Please upload it again.' : 'We could not read this scan. Please retry.';
    db.finishDocument(job.id, { status: 'failed', error });
    log.error('document failed', { documentId: job.id, error: err.message });
  }
}
