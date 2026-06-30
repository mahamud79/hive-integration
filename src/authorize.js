import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { createCodeVerifier, createCodeChallenge, createState } from './pkce.js';
import { saveTokens } from './tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  HIVE_CLIENT_ID,
  HIVE_CLIENT_SECRET,
  HIVE_REDIRECT_URI,
  HIVE_AUTHORIZE_URL,
  HIVE_TOKEN_URL,
  HIVE_SCOPES,
} = process.env;

function assertEnv() {
  const missing = [];
  if (!HIVE_CLIENT_ID) missing.push('HIVE_CLIENT_ID');
  if (!HIVE_CLIENT_SECRET) missing.push('HIVE_CLIENT_SECRET');
  if (!HIVE_REDIRECT_URI) missing.push('HIVE_REDIRECT_URI');
  if (missing.length) {
    console.error('Missing env vars: ' + missing.join(', '));
    console.error('Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: HIVE_REDIRECT_URI,
    client_id: HIVE_CLIENT_ID,
    client_secret: HIVE_CLIENT_SECRET,
    code_verifier: codeVerifier,
  });

  const res = await fetch(HIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error('Token exchange failed (' + res.status + '): ' + text);
  }
  return JSON.parse(text);
}

function main() {
  assertEnv();

  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const state = createState();

  // Build the query string MANUALLY so spaces in `scope` are encoded as %20
  // (matching Hive's docs) rather than the "+" that URLSearchParams emits.
  const params = [
    ['response_type', 'code'],
    ['client_id', HIVE_CLIENT_ID],
    ['redirect_uri', HIVE_REDIRECT_URI],
    ['scope', HIVE_SCOPES || 'events:write orders:write contacts:write'],
    ['code_challenge', codeChallenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
  ];
  const qs = params
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const authUrlString = HIVE_AUTHORIZE_URL + '?' + qs;

  // Write the URL to a file so it can be copied cleanly into the browser,
  // avoiding terminal line-wrap dropping/altering characters.
  const urlFilePath = path.join(__dirname, '..', 'authorize-url.txt');
  fs.writeFileSync(urlFilePath, authUrlString);

  const redirect = new URL(HIVE_REDIRECT_URI);
  const port = redirect.port || 3000;
  const callbackPath = redirect.pathname;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost:' + port);
    if (reqUrl.pathname !== callbackPath) {
      res.writeHead(404).end('Not found');
      return;
    }

    const returnedState = reqUrl.searchParams.get('state');
    const code = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Authorization failed</h1><pre>' + error + '</pre>');
      console.error('Authorization error:', error);
      process.exitCode = 1;
      server.closeAllConnections?.();
      server.close();
      return;
    }

    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>State mismatch</h1><p>Possible CSRF. Aborting.</p>');
      console.error('State mismatch - aborting.');
      process.exitCode = 1;
      server.closeAllConnections?.();
      server.close();
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code, codeVerifier);
      await saveTokens(tokens);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Success!</h1><p>Tokens saved. You can close this tab and return to the terminal.</p>');
      console.log('');
      console.log('Authorization complete. Tokens saved to tokens.json');
      console.log('Next: npm run test:event');
      server.closeAllConnections?.();
      server.close();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Token exchange failed</h1><pre>' + e.message + '</pre>');
      console.error(e.message);
      process.exitCode = 1;
      server.closeAllConnections?.();
      server.close();
    }
  });

  server.listen(port, () => {
    console.log('');
    console.log('=== Hive OAuth Authorization ===');
    console.log('Listening for the callback on ' + HIVE_REDIRECT_URI);
    console.log('');
    console.log('1) Open the URL below in your browser and log in / approve.');
    console.log('   (Also saved to: ' + urlFilePath + ' - copy from there if the terminal wraps it.)');
    console.log('');
    console.log(authUrlString);
    console.log('');
    console.log('2) After approving, Hive will redirect back here and tokens will be saved.');
  });
}

main();
