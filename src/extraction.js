import { extractReceipt } from './llm.js';

// Turns one page of a scan into an expense line. A failure on one page must
// not fail the whole scan: the page is saved with status 'failed' instead.
export async function extractPage(text) {
  try {
    const r = JSON.parse((await extractReceipt(text)).text);
    return {
      status: 'ok',
      merchant: r.merchant,
      date: r.date,
      totalCents: typeof r.total === 'number' ? Math.round(r.total * 100) : null,
      currency: r.currency,
      category: r.category,
      confidence: r.confidence,
      issues: [],
    };
  } catch (err) {
    return { status: 'failed', issues: [`Could not read this receipt: ${err.message}`] };
  }
}
