import path from 'node:path';

// All configuration comes from the environment. Secrets have no defaults: the
// server refuses to start without them rather than falling back to a value
// committed to the repo.

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
};

const dataDir = process.env.DATA_DIR || './data';

const config = {
  port: num('PORT', 3000),
  llmUrl: process.env.LLM_URL || 'http://localhost:4000/v1/messages',
  llmApiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL || 'claude-haiku-4-5',

  dataDir,
  dbPath: path.join(dataDir, 'receiptbox.db'),
  uploadDir: path.join(dataDir, 'uploads'),

  // Uploads. Our scanning app produces a few KB per receipt, so 10 MB / 500
  // pages is generous for one employee's trip and stops a single upload from
  // exhausting memory or the LLM budget.
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  maxPages: num('MAX_PAGES', 500),
  maxPageChars: num('MAX_PAGE_CHARS', 20_000),

  // Worker / LLM.
  workerConcurrency: num('WORKER_CONCURRENCY', 4), // documents processed at once
  pageConcurrency: num('PAGE_CONCURRENCY', 3), // LLM calls in flight per document
  llmRps: num('LLM_RPS', 6), // provider limit is 8 req/s per key; keep headroom
  llmTimeoutMs: num('LLM_TIMEOUT_MS', 30_000),
  llmMaxAttempts: num('LLM_MAX_ATTEMPTS', 5),

  // Below this the line is still counted but flagged for the employee to check.
  lowConfidence: 0.7,

  // Assistant: free-text questions per user per minute.
  askPerMinute: num('ASK_PER_MINUTE', 20),

  logLevel: process.env.LOG_LEVEL || 'info',
};

export function assertConfig() {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY is not set. Export it before starting the server (any value works with the local sandbox).');
  }
}

export default config;
