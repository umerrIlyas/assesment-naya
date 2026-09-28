import config from './config.js';

const PROMPT = `You are helping an employee fill in an expense report.
The page below is one scanned receipt. Extract:

- merchant: the name of the business
- date: the date of the purchase as YYYY-MM-DD
- total: the total amount paid, as a number (e.g. 1250.5)
- currency: the three-letter currency code, e.g. USD
- category: exactly one of meals, travel, lodging, office, software, other
- confidence: a number between 0 and 1

Respond with JSON only, in this shape:
{"merchant": "...", "date": "...", "total": 0, "currency": "...", "category": "...", "confidence": 0}

Receipt:
`;

async function callLLM(system, messages, maxTokens) {
  console.log('calling LLM with key', config.llmApiKey);

  const res = await fetch(config.llmUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  const body = await res.json();
  return body.content[0].text;
}

export async function extractReceipt(text) {
  const reply = await callLLM(undefined, [{ role: 'user', content: PROMPT + text }], 200);
  return JSON.parse(reply);
}

export async function chat(system, messages) {
  return callLLM(system, messages, 500);
}
