// HTTP collector: the browser / GTM POSTs here, and this server pushes to Hive
// server-side (holding the OAuth tokens, never exposing them to the client).
//
// Start: npm start    (reads .env, needs a valid tokens.json from `npm run authorize`)

import http from 'node:http';
import { pushEvents, pushOrders } from './hive.js';
import { buildEventPayload, buildOrderPayload, ValidationError } from './order-builder.js';

const PORT = Number(process.env.PORT || 8787);
// Lock this down to your storefront origin in production, e.g. https://www.bingoloco.com
const ALLOWED_ORIGIN = process.env.COLLECTOR_ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = 256 * 1024;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// POST /collect/order — upserts the event, then pushes the order so its
// event_id always matches an existing event in Hive.
async function handleOrder(payload) {
  const event = buildEventPayload(payload.event);
  const order = buildOrderPayload(payload);

  // Event first (so the order's event_id resolves), then the order.
  const eventRes = await pushEvents([event]);
  const orderRes = await pushOrders([order]);

  return {
    event_id: order.event_id,
    order_id: order.order_id,
    status: order.status,
    hive: { event: eventRes.status, order: orderRes.status },
  };
}

// POST /collect/event — upsert an event only (e.g. a catalog sync).
async function handleEvent(payload) {
  const event = buildEventPayload(payload.event || payload);
  const res = await pushEvents([event]);
  return { event_id: event.event_id, hive: { event: res.status } };
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (req.url === '/collect/order' || req.url === '/collect/event')) {
    try {
      const payload = await readJsonBody(req);
      const result = req.url === '/collect/order'
        ? await handleOrder(payload)
        : await handleEvent(payload);
      // 202: we forwarded to Hive, which itself processes asynchronously.
      return sendJson(res, 202, { accepted: true, ...result });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendJson(res, 422, { error: 'ValidationError', message: e.message });
      }
      // Errors thrown by hive.js carry a status + response from Hive.
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      console.error('Collector error:', e.message, e.response || '');
      return sendJson(res, status, {
        error: 'UpstreamError',
        message: e.message,
        details: e.response || null,
      });
    }
  }

  sendJson(res, 404, { error: 'NotFound', message: 'Unknown route' });
});

server.listen(PORT, () => {
  console.log('Hive collector listening on http://localhost:' + PORT);
  console.log('  POST /collect/order   (status "started" = abandoned cart, "completed" = purchase)');
  console.log('  POST /collect/event   (upsert an event only)');
  console.log('  GET  /health');
  console.log('Allowed CORS origin: ' + ALLOWED_ORIGIN);
});
