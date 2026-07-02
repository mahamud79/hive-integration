// HTTP collector + server-side OAuth.
//
// The browser / GTM POSTs checkout data here, and this server pushes to Hive
// server-side (holding the OAuth tokens, never exposing them to the client).
//
// Local:  npm run dev    (loads .env)
// Render: npm start      (uses the platform's environment variables)

import http from 'node:http';
import { URL } from 'node:url';
import { createCodeVerifier, createCodeChallenge, createState } from './pkce.js';
import { saveTokens, tokensExist } from './tokens.js';
import { pushEvents, pushOrders } from './hive.js';
import { buildEventPayload, buildOrderPayload, ValidationError } from './order-builder.js';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = (process.env.COLLECTOR_ALLOWED_ORIGIN || '*')
  .split(',')
  .map(o => o.trim());
const MAX_BODY_BYTES = 256 * 1024;

const {
  HIVE_CLIENT_ID,
  HIVE_CLIENT_SECRET,
  HIVE_REDIRECT_URI,
  HIVE_AUTHORIZE_URL,
  HIVE_TOKEN_URL,
  HIVE_SCOPES,
} = process.env;

// Short-lived PKCE state for the OAuth handshake (same process start->callback).
const pkceStore = new Map();
function rememberPkce(state, verifier) {
  // drop entries older than 10 minutes
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pkceStore) if (v.ts < cutoff) pkceStore.delete(k);
  pkceStore.set(state, { verifier, ts: Date.now() });
}

function setCors(res, reqOrigin) {
  let allow = '*';
  if (!ALLOWED_ORIGINS.includes('*')) {
    const ok = ALLOWED_ORIGINS.some(o => {
      if (o.startsWith('*.')) {
        return reqOrigin && reqOrigin.endsWith(o.slice(1));
      }
      return reqOrigin === o;
    });
    allow = ok ? reqOrigin : ALLOWED_ORIGINS[0];
  }
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new ValidationError('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new ValidationError('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
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
  if (!res.ok) throw new Error('Token exchange failed (' + res.status + '): ' + text);
  return JSON.parse(text);
}

// ---- collector handlers ----
async function handleOrder(payload) {
  const event = buildEventPayload(payload.event);
  const order = buildOrderPayload(payload);
  const eventRes = await pushEvents([event]);
  const orderRes = await pushOrders([order]);
  return {
    event_id: order.event_id,
    order_id: order.order_id,
    status: order.status,
    hive: { event: eventRes.status, order: orderRes.status },
  };
}

async function handleEvent(payload) {
  const event = buildEventPayload(payload.event || payload);
  const res = await pushEvents([event]);
  return { event_id: event.event_id, hive: { event: res.status } };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  const reqPath = u.pathname;

  // ---- OAuth: start the authorization (open this URL in your browser) ----
  if (req.method === 'GET' && reqPath === '/oauth/start') {
    if (!HIVE_CLIENT_ID || !HIVE_REDIRECT_URI || !HIVE_AUTHORIZE_URL) {
      return sendHtml(res, 500, '<h1>Missing OAuth config</h1><p>Set HIVE_CLIENT_ID, HIVE_REDIRECT_URI, HIVE_AUTHORIZE_URL.</p>');
    }
    const verifier = createCodeVerifier();
    const challenge = createCodeChallenge(verifier);
    const state = createState();
    rememberPkce(state, verifier);
    const params = [
      ['response_type', 'code'],
      ['client_id', HIVE_CLIENT_ID],
      ['redirect_uri', HIVE_REDIRECT_URI],
      ['scope', HIVE_SCOPES || 'events:write orders:write contacts:write'],
      ['code_challenge', challenge],
      ['code_challenge_method', 'S256'],
      ['state', state],
    ];
    // Optional: some beta partner grants require the brand/tour id on first auth.
    if (process.env.HIVE_TOUR_ID) params.push(['tour_id', process.env.HIVE_TOUR_ID]);
    const qs = params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    res.writeHead(302, { Location: HIVE_AUTHORIZE_URL + '?' + qs });
    return res.end();
  }

  // ---- OAuth: Hive redirects back here with the authorization code ----
  if (req.method === 'GET' && reqPath === '/oauth/callback') {
    const error = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    if (error) return sendHtml(res, 400, '<h1>Authorization failed</h1><pre>' + error + '</pre>');
    const entry = state && pkceStore.get(state);
    if (!entry) return sendHtml(res, 400, '<h1>Invalid or expired state</h1><p>Start again at /oauth/start</p>');
    pkceStore.delete(state);
    try {
      const tokens = await exchangeCodeForTokens(code, entry.verifier);
      await saveTokens(tokens);
      return sendHtml(res, 200, '<h1>Authorized!</h1><p>Tokens saved. The collector is ready.</p>');
    } catch (e) {
      return sendHtml(res, 500, '<h1>Token exchange failed</h1><pre>' + e.message + '</pre>');
    }
  }

  // ---- health / status ----
  if (req.method === 'GET' && (reqPath === '/health' || reqPath === '/')) {
    const authorized = await tokensExist();
    return sendJson(res, 200, { ok: true, authorized });
  }

  // ---- collector endpoints (CORS) ----
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (req.method === 'POST' && (reqPath === '/collect/order' || reqPath === '/collect/event')) {
    try {
      const payload = await readJsonBody(req);
      const result = reqPath === '/collect/order' ? await handleOrder(payload) : await handleEvent(payload);
      return sendJson(res, 202, { accepted: true, ...result });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendJson(res, 422, { error: 'ValidationError', message: e.message });
      }
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      console.error('Collector error:', e.message, e.response || '');
      return sendJson(res, status, { error: 'UpstreamError', message: e.message, details: e.response || null });
    }
  }

  sendJson(res, 404, { error: 'NotFound', message: 'Unknown route' });
});

server.listen(PORT, () => {
  console.log('Hive collector listening on port ' + PORT);
  console.log('  GET  /oauth/start      authorize this server with Hive (open in browser)');
  console.log('  GET  /oauth/callback   OAuth redirect target (register this URL in the portal)');
  console.log('  POST /collect/order    status "started" = abandoned cart, "completed" = purchase');
  console.log('  POST /collect/event    upsert an event only');
  console.log('  GET  /health           { ok, authorized }');
  console.log('Allowed CORS origin: ' + ALLOWED_ORIGIN);
});
