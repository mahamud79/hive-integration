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
 * Normalizes event objects before sending to Hive to avoid validation 422s.
 * - If event.event_url is an array, take the first element and stringify.
 * - If event.event_url is missing or doesn't look like http(s), delete it.
 * - If thumbnail_url is an array, take first element; otherwise stringify/trim.
 * - Ensure event_id is a string.
 */
function normalizeEventsForHive(events) {
  return (events || []).map(ev => {
    try {
      ev = ev || {};
      ev.event = ev.event || ev || {}; // some callers pass event object directly

      // Normalize event_url
      if (Array.isArray(ev.event.event_url)) {
        ev.event.event_url = ev.event.event_url.length ? String(ev.event.event_url[0]).trim() : '';
      } else if (ev.event.event_url != null) {
        ev.event.event_url = String(ev.event.event_url).trim();
      }

      // Remove invalid or generic event_url to avoid Hive validation errors
      if (!/^https?:\/\//i.test(ev.event.event_url || '') || /\/experiences\/?$/.test(ev.event.event_url || '')) {
        delete ev.event.event_url;
      }

      // Normalize thumbnail_url
      if (Array.isArray(ev.event.thumbnail_url)) {
        ev.event.thumbnail_url = ev.event.thumbnail_url.length ? String(ev.event.thumbnail_url[0]).trim() : undefined;
      } else if (ev.event.thumbnail_url != null) {
        ev.event.thumbnail_url = String(ev.event.thumbnail_url).trim() || undefined;
      }

      // Ensure event_id is a string if present
      if (ev.event.event_id != null) ev.event.event_id = String(ev.event.event_id).trim();

      return ev;
    } catch (err) {
      console.error('normalizeEventsForHive error', err, ev && ev.event && ev.event.event_id);
      return ev;
    }
  });
}

/**
 * Authenticated request to the Hive API.
 * Adds both required headers: Authorization + X-Partner-Id.
 * Retries once on 401 (in case the token expired between check and call).
 */
export async function hiveRequest(method, path, body, _retried = false) {
  const accessToken = await getAccessToken();

  console.log('HIVE OUTGOING /events:', JSON.stringify(body, null, 2));

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

  // Normalize events to avoid sending arrays for event_url/thumbnail_url
  const normalized = normalizeEventsForHive(events);
  return hiveRequest('POST', '/events', { events: normalized });
}

/**
 * POST /orders — create or update orders (upsert by order_id).
 * Use status "started" for abandoned carts, "completed" for purchases.
 *
 * Orders include nested event objects in some callers; normalize any nested events.
 */
export function pushOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error('pushOrders: provide a non-empty array of orders');
  }
  if (orders.length > 50) throw new Error('pushOrders: max 50 items per batch');

  // Normalize nested event objects inside orders if present (order.event or order.event.*)
  const ordersCopy = (orders || []).map(o => {
    try {
      const copy = JSON.parse(JSON.stringify(o)); // deep clone to avoid mutating callers
      if (copy.event) {
        const [normalizedEvent] = normalizeEventsForHive([ { event: copy.event } ]);
        copy.event = normalizedEvent && normalizedEvent.event ? normalizedEvent.event : copy.event;
      }
      // Some orders may include items with event-like fields; we won't mutate items here.
      return copy;
    } catch (err) {
      return o;
    }
  });

  return hiveRequest('POST', '/orders', { orders: ordersCopy });
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