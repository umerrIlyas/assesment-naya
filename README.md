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
- **`src/server.js`**: HTTP API (Node's built-in `http` module, no framework).
- **`src/worker.js`**: an in-process queue. It splits a scan into pages and sends each receipt to the LLM.
- **`src/llm.js`**: the prompts and the calls to the LLM provider.
- **`src/assistant.js`**: "Ask about your expenses": suggested questions answered in code, everything else sent to the LLM.
- **`src/db.js`**: a JSON-file database.
- **`public/index.html`**: the UI employees use to upload scans and review their expense report.
- **`vendor/llm-sandbox/`**: the provider's local sandbox, which speaks the Anthropic Messages API format. It comes prebuilt from the vendor, so treat it as a third-party service you don't control, and don't modify it.

There are no npm dependencies. You need Node 20+.

## Running it

```bash
npm run samples          # generate sample receipt scans into ./samples
npm run llm-sandbox      # terminal 1: the LLM provider on :4000
npm start                # terminal 2: ReceiptBox on :3000
```

Then open **http://localhost:3000**. Upload one of the sample scans, watch the receipts being read, and see the expense report fill in. Click any line to check it against the original receipt, and ask the assistant about your expenses.

`npm run demo` does the same from the terminal: it uploads the samples and prints a live status table. `npm run samples -- --big 600` also generates a ~600 MB file.

If port 3000 is already in use, start the server with `PORT=3001 npm start`.

### API

| Method | Path | Description |
|---|---|---|
| `POST` | `/documents?filename=x.txt` | Upload a scan (raw request body). Returns the document record. |
| `GET` | `/documents` | List uploaded scans with status and progress. |
| `GET` | `/documents/:id` | A scan with its extracted receipts. |
| `POST` | `/documents/:id/retry` | Re-process a scan. |
| `GET` | `/search?q=text&category=meals` | Expense report lines (extracted receipts), optionally filtered. |
| `GET` | `/questions` | Suggested questions for the assistant. |
| `POST` | `/ask` | Ask the assistant. Body: `{"question": "..."}`. Returns `{answer, source}`, where `source` is `report`, `llm` or `error`. |

```bash
curl -X POST --data-binary @samples/weekend-trip.txt "localhost:3000/documents?filename=weekend-trip.txt"
curl localhost:3000/documents
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
