// Uploads the sample documents and watches their status.
//   npm run demo            (uploads the three sample scans)
//   npm run demo -- 5       (uploads 5 extra copies of sales-quarter.txt)
// Needs RECEIPTBOX_TOKEN (from "npm run create-user -- <name>").

import fs from 'node:fs';

const BASE = process.env.RECEIPTBOX_URL || 'http://localhost:3000';
const TOKEN = process.env.RECEIPTBOX_TOKEN;
if (!TOKEN) {
  console.error('set RECEIPTBOX_TOKEN first (npm run create-user -- "Demo user")');
  process.exit(1);
}
const headers = { authorization: `Bearer ${TOKEN}` };
const extra = Number(process.argv[2] || 0);

const files = ['weekend-trip.txt', 'sales-quarter.txt', 'conference-trip.txt', ...Array(extra).fill('sales-quarter.txt')];
for (const f of files) {
  if (!fs.existsSync(`samples/${f}`)) {
    console.error(`samples/${f} missing — run "npm run samples" first`);
    process.exit(1);
  }
}

const uploaded = await Promise.all(
  files.map(async (f) => {
    const res = await fetch(`${BASE}/documents?filename=${f}`, {
      method: 'POST',
      headers,
      body: fs.readFileSync(`samples/${f}`),
    });
    return res.json();
  }),
);
console.log(`uploaded ${uploaded.length} documents`);

const started = Date.now();
while (true) {
  await new Promise((r) => setTimeout(r, 3000));
  const docs = await (await fetch(`${BASE}/documents`, { headers })).json();
  const mine = uploaded.map((u) => docs.find((d) => d.id === u.id) || { id: u.id, filename: u.filename, status: '(missing)' });
  console.clear();
  console.log(`t+${Math.round((Date.now() - started) / 1000)}s`);
  console.table(mine.map((d) => ({ id: d.id.slice(0, 8), file: d.filename, status: d.status, progress: d.progress, read: d.pageCount, review: d.needsReview, failed: d.failedPages })));
  if (mine.every((d) => d.status === 'done' || d.status === 'failed')) break;
}
