// Preflight diagnostic for the "invalid_client (Client not found)" error.
// Run: npm run diagnose

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodeVerifier, createCodeChallenge, createState } from './pkce.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  HIVE_CLIENT_ID,
  HIVE_CLIENT_SECRET,
  HIVE_REDIRECT_URI,
  HIVE_AUTHORIZE_URL,
  HIVE_SCOPES,
} = process.env;

function fail(msg) {
  console.error('[X] ' + msg);
  process.exitCode = 1;
}

function describe(label, value) {
  if (value == null) {
    fail(label + ' is MISSING from .env');
    return null;
  }
  const len = value.length;
  const suspicious = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const code = value.charCodeAt(i);
    if (!/[A-Za-z0-9\-_.~]/.test(c)) {
      suspicious.push('pos ' + i + '=' + JSON.stringify(c) + ' (code ' + code + ')');
    }
  }
  console.log('');
  console.log(label);
  console.log('  length      : ' + len);
  console.log('  preview     : ' + (len <= 8 ? '(too short to mask)' : value.slice(0, 4) + '...' + value.slice(-4)));
  if (suspicious.length) {
    fail('  contains ' + suspicious.length + ' suspicious char(s): ' + suspicious.join(', '));
  } else {
    console.log('  charset     : OK (only A-Z a-z 0-9 - _ . ~)');
  }
  return value;
}

function halfRedact(id) {
  const keep = Math.ceil(id.length / 2);
  return id.slice(0, keep) + 'X'.repeat(id.length - keep);
}

console.log('=== Hive OAuth preflight diagnostic ===');

const id = describe('HIVE_CLIENT_ID', HIVE_CLIENT_ID);
describe('HIVE_CLIENT_SECRET', HIVE_CLIENT_SECRET);

if (id && HIVE_CLIENT_SECRET) {
  if (id === HIVE_CLIENT_SECRET) {
    fail('HIVE_CLIENT_ID and HIVE_CLIENT_SECRET are IDENTICAL - you pasted the same value into both.');
  }
  if (id.length > HIVE_CLIENT_SECRET.length) {
    console.log('');
    console.log('[!] Your client_id is LONGER than your secret - double-check you did not swap them.');
  }
}

if (!HIVE_REDIRECT_URI) fail('HIVE_REDIRECT_URI is MISSING from .env');

if (id && HIVE_REDIRECT_URI && HIVE_AUTHORIZE_URL) {
  const codeChallenge = createCodeChallenge(createCodeVerifier());
  const state = createState();

  const params = [
    ['response_type', 'code'],
    ['client_id', id],
    ['redirect_uri', HIVE_REDIRECT_URI],
    ['scope', HIVE_SCOPES || 'events:write orders:write contacts:write'],
    ['code_challenge', codeChallenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
  ];
  const qs = params
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const fullUrl = HIVE_AUTHORIZE_URL + '?' + qs;

  const redactedQs = params
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(k === 'client_id' ? halfRedact(v) : v))
    .join('&');
  const redactedUrl = HIVE_AUTHORIZE_URL + '?' + redactedQs;

  console.log('');
  console.log('--- REDACTED authorize URL (safe to send to Hive) ---');
  console.log('');
  console.log(redactedUrl);

  const outPath = path.join(__dirname, '..', 'authorize-url.txt');
  fs.writeFileSync(outPath, fullUrl);
  console.log('');
  console.log('Full (unredacted) authorize URL written to: ' + outPath);
  console.log('Copy it FROM THAT FILE into your browser (avoids terminal copy errors).');
}

console.log('');
if (process.exitCode === 1) {
  console.log('Fix the [X] items above, then re-run: npm run diagnose');
} else {
  console.log('No problems detected in the values themselves.');
  console.log('If Hive still reports invalid_client, send them the REDACTED url above.');
}
