import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, '..', 'tokens.json');

// Persist the token set. We store an absolute expiry timestamp so we can
// refresh proactively instead of waiting for a 401.
export function saveTokens(tokenResponse) {
  const expiresInSec = Number(tokenResponse.expires_in || 3600);
  const record = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    token_type: tokenResponse.token_type || 'Bearer',
    // refresh ~60s before actual expiry to be safe
    expires_at: Date.now() + (expiresInSec - 60) * 1000,
    obtained_at: new Date().toISOString(),
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(record, null, 2));
  return record;
}

export function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error(
      'No tokens.json found. Run "npm run authorize" first to complete the OAuth flow.'
    );
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
}

export function tokensExist() {
  return fs.existsSync(TOKENS_PATH);
}

export function isExpired(tokens) {
  return !tokens.expires_at || Date.now() >= tokens.expires_at;
}
