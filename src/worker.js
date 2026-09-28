import fs from 'node:fs';
import config from './config.js';
import * as db from './db.js';
import { extractReceipt } from './llm.js';

const queue = [];
let running = 0;

export function enqueue(documentId) {
  queue.push(documentId);
}

export function startWorker() {
  setInterval(() => {
    while (running < config.workerConcurrency && queue.length > 0) {
      const id = queue.shift();
      running++;
      processDocument(id).finally(() => running--);
    }
  }, 500);
}

async function processDocument(id) {
  const data = db.load();
  const doc = data.documents[id];
  doc.status = 'processing';
  db.save(data);

  try {
    const text = fs.readFileSync(doc.filePath, 'utf8');
    const pages = text.split('\f');

    for (let i = 0; i < pages.length; i++) {
      const pageText = pages[i].trim();
      if (!pageText) continue;

      const result = await extractReceipt(pageText);

      doc.pages.push({
        pageNumber: doc.pages.length + 1,
        text: pageText,
        ...result,
      });
      doc.progress = `${i + 1}/${pages.length}`;
      db.save(data);
    }

    doc.status = 'done';
    db.save(data);
    console.log('finished document', id);
  } catch (err) {
    console.log('error processing document', id, err.message);
    doc.error = err.message; // shown next to the scan in the UI
    db.save(data);
  }
}
