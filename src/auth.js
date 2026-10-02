import * as db from './db.js';

// Placeholder until per-user tokens land: everyone is the single local user.
const LOCAL_USER = { id: 'local', name: 'Local user' };
let ensured = false;
export function authenticate() {
  if (!ensured) {
    if (!db.findUserByTokenHash('local')) db.createUser({ ...LOCAL_USER, tokenHash: 'local' });
    ensured = true;
  }
  return LOCAL_USER;
}
