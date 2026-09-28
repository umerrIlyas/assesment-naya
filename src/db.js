import fs from 'node:fs';
import config from './config.js';

export function load() {
  if (!fs.existsSync(config.dbPath)) {
    return { documents: {} };
  }
  return JSON.parse(fs.readFileSync(config.dbPath, 'utf8'));
}

export function save(data) {
  fs.writeFileSync(config.dbPath, JSON.stringify(data, null, 2));
}
