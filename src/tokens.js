import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- token store backends -------------------------------------------------
// Default: a local file (good for local dev / a persistent disk).
// Optional: Upstash Redis (REST) for durable storage on ephemeral hosts like
// Render's free tier. Enabled automatically when both env vars are present.
const TOKENS_PATH = process.env.TOKENS_FILE
  ? path.resolve(process.env.TOKENS_FILE)
  : path.join(__dirname, '..', 'tokens.json');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = process.env.TOKENS_REDIS_KEY || 'hive_tokens';
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

async function redisCommand(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Token store (Redis) error ' + res.status + ': ' + text);
  return text ? JSON.parse(text) : {};
}

function buildRecord(tokenResponse) {
  const expiresInSec = Number(tokenResponse.expires_in || 3600);
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    token_type: tokenResponse.token_type || 'Bearer',
    // refresh ~60s before actual expiry to be safe
    expires_at: Date.now() + (expiresInSec - 60) * 1000,
    obtained_at: new Date().toISOString(),
  };
}

// Persist the token set (async; supports Redis or file).
export async function saveTokens(tokenResponse) {
  const record = buildRecord(tokenResponse);
  if (useRedis) {
    await redisCommand(['SET', REDIS_KEY, JSON.stringify(record)]);
  } else {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(record, null, 2));
  }
  return record;
}

export async function loadTokens() {
  if (useRedis) {
    const out = await redisCommand(['GET', REDIS_KEY]);
    if (!out || out.result == null) {
      throw new Error('No tokens in store. Visit /oauth/start to authorize.');
    }
    return typeof out.result === 'string' ? JSON.parse(out.result) : out.result;
  }
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error('No tokens found. Run "npm run authorize" (local) or visit /oauth/start (server).');
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
}

export async function tokensExist() {
  try {
    if (useRedis) {
      const out = await redisCommand(['GET', REDIS_KEY]);
      return Boolean(out && out.result != null);
    }
    return fs.existsSync(TOKENS_PATH);
  } catch {
    return false;
  }
}

export function isExpired(tokens) {
  return !tokens || !tokens.expires_at || Date.now() >= tokens.expires_at;
}
