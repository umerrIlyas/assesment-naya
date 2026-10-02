import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

// A fake provider whose next responses are scripted per test.
let script = [];
let calls = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req);
  calls++;
  const step = script.shift() ?? { status: 200 };
  if (step.hang) return; // never answer
  res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers });
  res.end(JSON.stringify(step.status === 200 ? { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } : { error: { message: 'nope' } }));
});

before(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.LLM_URL = `http://localhost:${server.address().port}/v1/messages`;
  process.env.LLM_API_KEY = 'k';
  process.env.LLM_TIMEOUT_MS = '300';
  process.env.LLM_MAX_ATTEMPTS = '3';
  process.env.LLM_RPS = '1000';
  process.env.LOG_LEVEL = 'error';
});
after(() => server.close());

const llm = () => import('../src/llm.js');
const run = async (steps) => {
  script = steps;
  calls = 0;
  return (await llm()).callLLM({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
};

test('retries transient errors and honours retry-after', async () => {
  const started = Date.now();
  const reply = await run([{ status: 429, headers: { 'retry-after': '1' } }, { status: 529 }, { status: 200 }]);
  assert.equal(reply.text, 'hi');
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 1000, 'waited for retry-after');
});

test('times out a hung request and retries it', async () => {
  const reply = await run([{ hang: true }, { status: 200 }]);
  assert.equal(reply.text, 'hi');
  assert.equal(calls, 2);
});

test('gives up after max attempts', async () => {
  await assert.rejects(run([{ status: 500 }, { status: 500 }, { status: 500 }]), /LLM provider error/);
  assert.equal(calls, 3);
});

test('does not retry client errors; auth errors are fatal', async () => {
  await assert.rejects(run([{ status: 400 }]), (err) => !err.retryable && !err.fatal);
  assert.equal(calls, 1);
  await assert.rejects(run([{ status: 401 }]), (err) => err.fatal);
  assert.equal(calls, 1);
});
