import { loadTokens, isExpired } from './tokens.js';
import { refreshTokens } from './refresh.js';

const { HIVE_API_BASE, HIVE_CLIENT_ID } = process.env;

// Returns a valid access token, refreshing proactively if it has expired.
async function getAccessToken() {
  let tokens = await loadTokens();
  if (isExpired(tokens)) {
    console.log('Access token expired - refreshing...');
    tokens = await refreshTokens();
  }
  return tokens.access_token;
}

/**
 * Authenticated request to the Hive API.
 * Adds both required headers: Authorization + X-Partner-Id.
 * Retries once on 401 (in case the token expired between check and call).
 */
export async function hiveRequest(method, path, body, _retried = false) {
  const accessToken = await getAccessToken();

  const res = await fetch(`${HIVE_API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'X-Partner-Id': HIVE_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (res.status === 401 && !_retried) {
    await refreshTokens();
    return hiveRequest(method, path, body, true);
  }

  // 202 Accepted = queued for async processing (this is success for ingestion).
  if (!res.ok) {
    const err = new Error(`Hive ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return { status: res.status, data };
}

/**
 * POST /events — create or update events (upsert by event_id).
 */
export function pushEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('pushEvents: provide a non-empty array of events');
  }
  if (events.length > 50) throw new Error('pushEvents: max 50 items per batch');
  return hiveRequest('POST', '/events', { events });
}

/**
 * POST /orders — create or update orders (upsert by order_id).
 * Use status "started" for abandoned carts, "completed" for purchases.
 */
export function pushOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error('pushOrders: provide a non-empty array of orders');
  }
  if (orders.length > 50) throw new Error('pushOrders: max 50 items per batch');
  return hiveRequest('POST', '/orders', { orders });
}

/**
 * POST /contacts — create or update contacts (upsert by email/phone).
 */
export function pushContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new Error('pushContacts: provide a non-empty array of contacts');
  }
  if (contacts.length > 50) throw new Error('pushContacts: max 50 items per batch');
  return hiveRequest('POST', '/contacts', { contacts });
}
