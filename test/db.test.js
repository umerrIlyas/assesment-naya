import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import * as db from '../src/db.js';

test('db saves and loads', () => {
  fs.mkdirSync('./data', { recursive: true });
  const data = db.load();
  data.documents.test = { id: 'test', pages: [] };
  db.save(data);
  assert.equal(db.load().documents.test.id, 'test');
});
