// Shapes returned by the API. Internal fields (file paths, user ids) never leave
// the server. Field names the frontend already used are kept for compatibility.

export const CATEGORIES = ['meals', 'travel', 'lodging', 'office', 'software', 'other'];

export function toPublicDocument(d) {
  return {
    id: d.id,
    filename: d.filename,
    status: d.status,
    progress: d.pageCount == null ? null : `${d.pagesProcessed}/${d.pageCount}`,
    pageCount: d.pagesProcessed, // receipts read so far (same meaning as before)
    receiptCount: d.pageCount, // receipts in the scan, once it has been split
    needsReview: d.needsReview,
    failedPages: d.failedPages,
    error: d.error ?? undefined,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function toPublicLine(p) {
  return {
    documentId: p.documentId,
    filename: p.filename,
    pageNumber: p.pageNumber,
    status: p.status,
    issues: p.issues,
    merchant: p.merchant,
    date: p.date,
    total: p.totalCents == null ? null : p.totalCents / 100,
    totalCents: p.totalCents,
    currency: p.currency,
    category: p.category,
    confidence: p.confidence,
    ...(p.snippet !== undefined && { snippet: p.snippet }),
  };
}
