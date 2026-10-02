import config from './config.js';
import { extractReceipt } from './llm.js';
import { CATEGORIES } from './views.js';

// Turns one page of a scan into an expense line.
//
// The LLM's reply is not trusted: it is parsed tolerantly (code fences, prose
// around the JSON), then every field is validated and normalised. Anything we
// cannot vouch for becomes an "issue", and a line with issues is saved as
// 'needs_review': it is shown to the employee but not counted as reimbursable
// until checked. A failure on one page never fails the whole scan.

const SYMBOL_CURRENCY = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const MAX_REASONABLE_CENTS = 100_000 * 100; // a single receipt over 100k is almost certainly a misread

/** Find the JSON object in a reply that may be wrapped in fences or prose. */
export function parseJsonObject(reply) {
  if (typeof reply !== 'string') return null;
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(reply.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** "1,840.00" / "168,30" / "1.234,56" / "12" -> cents, or null. */
export function numberTokenToCents(token) {
  const m = String(token).match(/^(\d+(?:[.,]\d+)*?)(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  const whole = Number(m[1].replace(/[.,]/g, ''));
  const fraction = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return Number.isFinite(whole) ? whole * 100 + fraction : null;
}

/** Parse the LLM's total, which may be a number or a string like "$400.68". */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { cents: Math.round(value * 100) } : null;
  if (typeof value !== 'string') return null;
  const symbol = Object.keys(SYMBOL_CURRENCY).find((s) => value.includes(s));
  const token = value.replace(/[^\d.,-]/g, '');
  if (token.startsWith('-')) return { cents: -1 };
  const cents = numberTokenToCents(token);
  return cents == null ? null : { cents, currency: symbol && SYMBOL_CURRENCY[symbol] };
}

/** Every amount written on the receipt, in cents. */
export function amountsInText(text) {
  const amounts = new Set();
  for (const token of text.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const cents = numberTokenToCents(token);
    if (cents != null) amounts.add(cents);
  }
  return amounts;
}

const isRealDate = (y, m, d) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/** Accept YYYY-MM-DD, and the US MM/DD/YYYY the model sometimes returns. */
export function parseDate(value) {
  if (typeof value !== 'string') return null;
  let m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m && isRealDate(+m[1], +m[2], +m[3])) return `${m[1]}-${m[2]}-${m[3]}`;
  m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m && isRealDate(+m[3], +m[1], +m[2])) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

// Text in a receipt that addresses an AI system is a prompt-injection attempt
// (or at best a very unusual receipt). Either way a human should check it.
const INJECTION_PATTERNS = [
  /\b(note|message|instructions?)\s+(for|to)\s+(the\s+)?(ai|llm|assistant|model|chatbot|gpt|claude)s?\b/i,
  /\bignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?)/i,
  /\b(ai|llm|assistant|model)s?\b[^\n]{0,60}\b(report|record|set|use|treat|enter)\b[^\n]{0,60}\b(total|amount)\b/i,
  /\b(system prompt|you are an? (ai|assistant|language model))\b/i,
];
export const looksLikeInjection = (text) => INJECTION_PATTERNS.some((re) => re.test(text));

/** Validate and normalise the LLM's fields against the receipt text. */
export function normalise(raw, text) {
  const issues = [];
  const out = { merchant: null, date: null, totalCents: null, currency: null, category: null, confidence: null };

  if (typeof raw.merchant === 'string' && raw.merchant.trim()) out.merchant = raw.merchant.trim().slice(0, 200);
  else issues.push('Merchant could not be read');

  out.date = parseDate(raw.date);
  if (!out.date) issues.push('Date could not be read');

  const amount = parseAmount(raw.total);
  if (!amount) {
    issues.push('Amount could not be read');
  } else if (amount.cents <= 0 || amount.cents > MAX_REASONABLE_CENTS) {
    issues.push('Amount looks wrong');
  } else {
    out.totalCents = amount.cents;
    // The amount must actually be printed on the receipt; the model must not invent or compute it.
    if (!amountsInText(text).has(amount.cents)) issues.push('Amount does not appear on the receipt');
  }

  const currency = typeof raw.currency === 'string' && /^[A-Za-z]{3}$/.test(raw.currency.trim()) ? raw.currency.trim().toUpperCase() : amount?.currency;
  if (currency) out.currency = currency;
  else issues.push('Currency could not be read');

  const category = typeof raw.category === 'string' ? raw.category.trim().toLowerCase() : '';
  out.category = CATEGORIES.includes(category) ? category : 'other';
  if (!CATEGORIES.includes(category)) issues.push('Category unclear');

  const confidence = typeof raw.confidence === 'string' ? Number(raw.confidence) : raw.confidence;
  if (typeof confidence === 'number' && confidence >= 0 && confidence <= 1) out.confidence = confidence;

  if (looksLikeInjection(text)) issues.push('Receipt contains instructions aimed at an AI; check the amount by hand');

  return { ...out, issues };
}

export async function extractPage(fullText) {
  const issues = [];
  let text = fullText;
  if (text.length > config.maxPageChars) {
    text = text.slice(0, config.maxPageChars);
    issues.push('Page is unusually long; only the beginning was read');
  }

  // The model's output is noisy (truncated JSON, prose, dropped fields) but the
  // noise is random, so another attempt or two fixes it. Keep the better result.
  // Issues that come from the receipt itself (injection, amount not printed)
  // would not change on retry, so they don't trigger one.
  const RECEIPT_ISSUES = new Set(['Amount does not appear on the receipt', 'Receipt contains instructions aimed at an AI; check the amount by hand']);
  let best = null;
  let unreadable = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let reply;
    try {
      reply = await extractReceipt(text);
    } catch (err) {
      if (err.fatal) throw err;
      if (best) break;
      return { status: 'failed', issues: [...issues, 'The AI service was unavailable for this receipt. Retry the scan.'] };
    }
    const parsed = reply.stopReason === 'max_tokens' ? null : parseJsonObject(reply.text);
    if (!parsed) {
      if (!reply.text.includes('{')) unreadable = true; // model says it cannot read the page
      if (unreadable) break;
      continue;
    }
    const line = normalise(parsed, text);
    if (!best || line.issues.length < best.issues.length) best = line;
    if (best.issues.every((i) => RECEIPT_ISSUES.has(i))) break;
  }

  if (!best) {
    return { status: 'needs_review', issues: [...issues, 'This receipt could not be read automatically. Enter it by hand.'] };
  }
  best.issues = [...issues, ...best.issues];
  return { status: best.issues.length ? 'needs_review' : 'ok', ...best };
}
