# ReceiptBox

ReceiptBox fills in expense reports.

After a business trip, an employee has a pile of paper receipts: coffee with a client, taxis, the hotel, the flight. Today they type every one into an expense report by hand: merchant, date, amount, category.

With ReceiptBox, they scan all their receipts into one file with our scanning app (one receipt per page) and upload it. An LLM reads each receipt, and the expense report fills itself in, with the total to reimburse. The employee checks it and submits it to finance.

A teammate built it as a prototype.

### What the LLM does

For **each page** (one receipt), the LLM gets the receipt text and returns:

```json
{
  "merchant": "The Parkside Hotel",
  "date": "2026-03-09",
  "total": 400.68,
  "currency": "USD",
  "category": "lodging",
  "confidence": 0.87
}
```

| Field | Meaning |
|---|---|
| `merchant` | The business on the receipt |
| `date` | Date of purchase, `YYYY-MM-DD` |
| `total` | Amount paid, as a number |
| `currency` | Three-letter currency code |
| `category` | `meals`, `travel`, `lodging`, `office`, `software` or `other` |
| `confidence` | How sure the model is, 0–1 |

Each extracted receipt becomes one line of the expense report, and finance reimburses the total. We use an LLM because every merchant's receipt looks different, and rules don't generalise.

### Ask about your expenses

Below the report, employees can ask questions about it. Suggested questions ("What is my total to reimburse?", "What was my biggest expense?", "Which receipts need review?", and so on) are answered in code, straight from the database. Anything else they type goes to the LLM along with their report, so they can ask things like "How much did I spend at Bistro Verde?".

## How it works

```
             POST /documents                   ┌──────────────┐
  employee ───────────────────► server.js ───► │ data/uploads │  (the scan)
                                    │          └──────────────┘
                                    │ enqueue(id)
                                    ▼
                               worker.js ── for each receipt ──► llm.js ───► LLM provider
                                    │
                                    ▼
                              data/db.json  ◄──── GET /documents, /search
                                    ▲
                                    └──── assistant.js ◄──── POST /ask ──► llm.js (free-text questions)
```

- **Scans** are plain text, as our scanning app exports them: one receipt per page, with pages separated by a form-feed character (`\f`).
- **`src/server.js`**: HTTP API (Node's built-in `http` module, no framework). Streams uploads to disk with size/page limits.
- **`src/auth.js`**: email + password sign-up/login with server-side sessions (HttpOnly cookie), plus API tokens for scripts. All data is scoped to the user.
- **`src/worker.js`**: background worker. The queue is the `documents` table, so work survives restarts. It splits a scan into pages and sends each receipt to the LLM.
- **`src/llm.js`**: the prompts and the calls to the LLM provider: rate limiting, timeouts, retries.
- **`src/extraction.js`**: parses and validates the LLM's reply; flags lines that need review.
- **`src/assistant.js`**: "Ask about your expenses": suggested questions answered in code, everything else sent to the LLM.
- **`src/db.js`**: SQLite (Node's built-in `node:sqlite`). Amounts are stored in cents.
- **`public/index.html`**: the UI employees use to upload scans and review their expense report.
- **`vendor/llm-sandbox/`**: the provider's local sandbox, which speaks the Anthropic Messages API format. It comes prebuilt from the vendor, so treat it as a third-party service you don't control, and don't modify it.

There are no npm dependencies. You need Node 22.13+ (for `node:sqlite`).

## Running it

```bash
npm run samples                       # generate sample receipt scans into ./samples
npm run create-user -- "Your Name"    # optional: an API token for scripts/curl (shown once)
npm run llm-sandbox                   # terminal 1: the LLM provider on :4000
LLM_API_KEY=dev npm start             # terminal 2: ReceiptBox on :3000 (any key works with the sandbox)
npm test                              # unit + end-to-end tests (starts its own sandbox and server)
```

Then open **http://localhost:3000**, create an account and log in. Upload one of the sample scans, watch the receipts being read, and see the expense report fill in. Click any line to check it against the original receipt, and ask the assistant about your expenses.

`RECEIPTBOX_TOKEN=<token> npm run demo` does the same from the terminal: it uploads the samples and prints a live status table. `npm run samples -- --big 600` also generates a ~600 MB file.

If port 3000 is already in use, start the server with `PORT=3001 npm start`.

Configuration is by environment variable (see `src/config.js`): `LLM_API_KEY` (required), `LLM_URL`, `LLM_MODEL`, `PORT`, `DATA_DIR`, `MAX_UPLOAD_BYTES`, `MAX_PAGES`, `LLM_RPS`, `LLM_TIMEOUT_MS`, `WORKER_CONCURRENCY`, `PAGE_CONCURRENCY`, `LOG_LEVEL`, `COOKIE_SECURE` (defaults to on when `NODE_ENV=production`), `LOGIN_MAX_FAILURES`.

### API

All routes except `/`, `/health`, `/samples/*`, `/questions` and `/auth/signup|login|logout` need a session cookie (from login) or `Authorization: Bearer <token>`. Cookie-authenticated writes must come from the same origin. Errors are `{"error": "message"}` with a 4xx/5xx status.

| Method | Path | Description |
|---|---|---|
| `POST` | `/documents?filename=x.txt` | Upload a scan (raw request body, ≤ 10 MB, ≤ 500 pages; else `413`). Returns the document record. |
| `GET` | `/documents` | Your scans with status (`pending`, `processing`, `done`, `failed`), progress, and counts of lines needing review / failed. |
| `GET` | `/documents/:id` | A scan with its extracted receipts. |
| `POST` | `/documents/:id/retry` | Re-process a scan (replaces its lines). `409` while it is still processing. |
| `GET` | `/search?q=text&category=meals` | Your expense report lines, optionally filtered (filters combine; text search is case-insensitive). |
| `GET` | `/questions` | Suggested questions for the assistant. |
| `POST` | `/ask` | Ask the assistant. Body: `{"question": "..."}`. Returns `{answer, source}`, where `source` is `report`, `llm` or `error`. |
| `GET` | `/health` | Liveness/readiness check. |
| `POST` | `/auth/signup` | `{"name", "email", "password"}` (password ≥ 10 chars). Creates the account and logs in (sets the session cookie). `409` if the email is taken. |
| `POST` | `/auth/login` | `{"email", "password"}`. Sets the session cookie. `401` on wrong credentials, `429` after repeated failures. |
| `POST` | `/auth/logout` | Ends the session. |
| `GET` | `/auth/me` | The logged-in user. |

Each expense line has `status` (`ok`, `needs_review` or `failed`) and `issues` (reasons, for the employee). Only `ok` lines count towards the total to reimburse. Amounts are given as `total` (number) and `totalCents` (integer); totals are never added across currencies.

```bash
curl -X POST -H "authorization: Bearer $TOKEN" --data-binary @samples/weekend-trip.txt "localhost:3000/documents?filename=weekend-trip.txt"
curl -H "authorization: Bearer $TOKEN" localhost:3000/documents
```

---

## Your task

> **This is going to real customers next week. Make it production-ready.**
> **You decide what that means, and write down what you did and what you deliberately skipped.**

We don't expect you to do everything in the time available. We're more interested in **what you choose to work on and why** than in how much you change.

- **Time box: about 2–3 hours.** Stop when you hit it, and write down what you'd do next.
- You can change anything: structure, storage, API shape. You can add dependencies if you can justify them. The API is used by our frontend, though, so call out any breaking changes.
- Don't modify `vendor/`.

### What to send us

1. **Your code**, as a git repo, with commits as you went. Don't squash; we want to see how you progressed.
2. **`NOTES.md`** (aim for one page):
   - What problems you found, and how you found them.
   - What you changed, in priority order, and why that order.
   - What you deliberately skipped, and the risk of shipping without it.
   - How you verified your changes work.
   - What you'd do with another day to work on this assignment.
3. **If you used any AI tools, your session logs** (transcripts or chat exports), in a `logs/` folder or linked from `NOTES.md`.

### Follow-up call (45 min)

You'll walk us through your changes, followed by a technical discussion.
