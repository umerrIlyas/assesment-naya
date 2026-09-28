import * as db from './db.js';
import { chat } from './llm.js';

// "Ask about your expenses". The suggested questions are answered straight from
// the database; anything else the employee types goes to the LLM.

export const SUGGESTED = {
  'What is my total to reimburse?': (lines) => {
    let total = 0;
    for (const line of lines) total += line.total;
    return `Your total to reimburse is **$${total}** across ${lines.length} receipts.`;
  },

  'How much did I spend on meals?': (lines) => {
    const meals = lines.filter((l) => l.category === 'meals');
    const sum = meals.reduce((acc, l) => acc + l.total, 0);
    return `You spent **$${Math.round(sum * 100) / 100}** on meals (${meals.length} receipts).`;
  },

  'What was my biggest expense?': (lines) => {
    const top = [...lines].sort((a, b) => b.total - a.total)[0];
    return `Your biggest expense was **${top.merchant}**: $${top.total.toFixed(2)} on ${top.date}.`;
  },

  'Which receipts need review?': (lines) => {
    const low = lines.filter((l) => l.confidence < 0.7);
    if (low.length === 0) return 'Nothing needs review. The LLM was confident about every receipt.';
    return `${low.length} receipt(s) have low confidence: ` + low.map((l) => `**${l.merchant}** (${l.filename} p.${l.pageNumber})`).join(', ');
  },

  'How many receipts have I uploaded?': (lines) => `You have uploaded **${lines.length}** receipts.`,
};

const ASSISTANT_PROMPT = `You are ReceiptBox's expense assistant. Answer the employee's question about their
expense report in one or two sentences, using only the receipts provided. Use **bold** for amounts.`;

// Conversation so far, so the LLM can answer follow-up questions.
const history = [];

export async function ask(question) {
  const data = db.load();
  const lines = [];
  for (const doc of Object.values(data.documents)) {
    for (const page of doc.pages) lines.push({ filename: doc.filename, ...page });
  }

  if (SUGGESTED[question]) {
    return { answer: SUGGESTED[question](lines), source: 'report' };
  }

  try {
    history.push({
      role: 'user',
      content: `Expense report lines, with the text of each receipt:\n<receipts>\n${JSON.stringify(lines)}\n</receipts>\n\nQuestion: ${question}`,
    });
    const answer = await chat(ASSISTANT_PROMPT, history);
    history.push({ role: 'assistant', content: answer });
    return { answer, source: 'llm' };
  } catch (err) {
    console.log('assistant error', err.message);
    return { answer: `Sorry, something went wrong: ${err.message}`, source: 'error' };
  }
}
