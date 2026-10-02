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
  if (step.sse) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    ev({ type: 'message_start', message: {} });
    for (const piece of step.sse) {
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
      await new Promise((r) => setTimeout(r, 20));
    }
    if (step.failMidStream) {
      ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
      return res.end();
    }
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    ev({ type: 'message_stop' });
    return res.end();
  }
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

const runStream = async (steps) => {
  script = steps;
  calls = 0;
  const pieces = [];
  const reply = await (await llm()).callLLMStream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10, onText: (t) => pieces.push(t) });
  return { reply, pieces };
};

test('streams text deltas as they arrive', async () => {
  const { reply, pieces } = await runStream([{ sse: ['Your ', 'total ', 'is $5.'] }]);
  assert.deepEqual(pieces, ['Your ', 'total ', 'is $5.']);
  assert.equal(reply.text, 'Your total is $5.');
  assert.equal(reply.stopReason, 'end_turn');
});

test('falls back to one chunk when the provider does not stream', async () => {
  const { reply, pieces } = await runStream([{ status: 200 }]);
  assert.deepEqual(pieces, ['hi']);
  assert.equal(reply.text, 'hi');
});

test('retries a stream that fails before any text, but not after', async () => {
  const { pieces } = await runStream([{ status: 529 }, { sse: ['ok'] }]);
  assert.deepEqual(pieces, ['ok']);
  assert.equal(calls, 2);

  script = [{ sse: ['partial '], failMidStream: true }, { sse: ['again'] }];
  calls = 0;
  const seen = [];
  await assert.rejects((await llm()).callLLMStream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10, onText: (t) => seen.push(t) }), /Overloaded/);
  assert.deepEqual(seen, ['partial '], 'text already shown is not repeated by a retry');
  assert.equal(calls, 1);
});

test('stops when the caller aborts', async () => {
  script = [{ hang: true }];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects((await llm()).callLLMStream({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10, onText: () => {}, signal: controller.signal }), { name: 'AbortError' });
});
