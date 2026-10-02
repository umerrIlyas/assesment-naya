// Creates an employee account and prints its API token (shown once, store it safely).
//   npm run create-user -- "Alice Example"

import { open, close } from '../src/db.js';
import { createUser } from '../src/auth.js';

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('usage: npm run create-user -- "<name>"');
  process.exit(1);
}
open();
const { user, token } = createUser(name);
close();
console.log(`created user ${user.name} (${user.id})`);
console.log(`token: ${token}`);
