// Amounts are integer minor units (cents). Different currencies are never added
// together: there is no exchange rate here, and finance converts at payout.

export function sumByCurrency(lines) {
  const totals = new Map();
  for (const l of lines) {
    if (l.totalCents == null || !l.currency) continue;
    totals.set(l.currency, (totals.get(l.currency) ?? 0) + l.totalCents);
  }
  return totals;
}

export function formatMoney(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "$1,234.50 + €168.30", or "$0.00" when empty. */
export function formatTotals(totals) {
  if (totals.size === 0) return formatMoney(0);
  return [...totals].map(([currency, cents]) => formatMoney(cents, currency)).join(' + ');
}
