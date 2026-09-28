export default {
  port: process.env.PORT || 3000,
  llmUrl: process.env.LLM_URL || 'http://localhost:4000/v1/messages',
  llmApiKey: process.env.LLM_API_KEY || 'sk-live-receiptbox-8f2a91c4e7b3d6a0',
  model: 'claude-haiku-4-5',
  dbPath: './data/db.json',
  uploadDir: './data/uploads',
  workerConcurrency: 4,
};
