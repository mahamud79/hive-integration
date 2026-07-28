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
 * Safe normalization for event objects before sending to Hive.
 * - Accepts either an array of event objects OR an array of { event: {...} } wrappers.
 * - Returns an array of event objects (no wrappers) and never mutates input objects.
 */
function normalizeEventsForHive(items) {
  return (items || []).map(item => {
    try {
      // Accept either item = { event: {...} } OR item = {...event fields...}
      const src = (item && item.event) ? item.event : item || {};
      const ev = Object.assign({}, src); // shallow clone to avoid mutating callers

      // Normalize event_url
      if (Array.isArray(ev.event_url)) {
        ev.event_url = ev.event_url.length ? String(ev.event_url[0]).trim() : undefined;
      } else if (ev.event_url != null) {
        ev.event_url = String(ev.event_url).trim() || undefined;
      }

      // Remove invalid or generic event_url to avoid Hive validation errors
      if (ev.event_url && (!/^https?:\/\//i.test(ev.event_url) || /\/experiences\/?$/.test(ev.event_url))) {
        delete ev.event_url;
      }

      // Normalize thumbnail_url
      if (Array.isArray(ev.thumbnail_url)) {
        ev.thumbnail_url = ev.thumbnail_url.length ? String(ev.thumbnail_url[0]).trim() : undefined;
      } else if (ev.thumbnail_url != null) {
        ev.thumbnail_url = String(ev.thumbnail_url).trim() || undefined;
      }

      // Ensure event_id is a string if present
      if (ev.event_id != null) ev.event_id = String(ev.event_id).trim();

      return ev;
    } catch (err) {
      console.error('normalizeEventsForHive error', err);
      // Fall back to original item to avoid dropping events entirely
      return (item && item.event) ? item.event : item;
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

  // Safe logging: guard against circular structures
  try {
    console.log('HIVE OUTGOING ' + path + ':', JSON.stringify(body, null, 2));
  } catch (err) {
    console.log('HIVE OUTGOING ' + path + ': <unserializable payload>');
  }

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
 * Expects an array of event objects (or wrappers). We'll normalize and send event objects.
 */
export function pushEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('pushEvents: provide a non-empty array of events');
  }
  if (events.length > 50) throw new Error('pushEvents: max 50 items per batch');

  const normalized = normalizeEventsForHive(events);
  return hiveRequest('POST', '/events', { events: normalized });
}

/**
 * POST /orders — create or update orders (upsert by order_id).
 * Normalize any nested order.event (if present) to avoid arrays/invalid URLs.
 */
export function pushOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error('pushOrders: provide a non-empty array of orders');
  }
  if (orders.length > 50) throw new Error('pushOrders: max 50 items per batch');

  const ordersCopy = (orders || []).map(o => {
    try {
      const copy = JSON.parse(JSON.stringify(o)); // deep clone to avoid mutating callers
      if (copy.event) {
        const [normalizedEvent] = normalizeEventsForHive([copy.event]);
        copy.event = normalizedEvent || copy.event;
      }
      return copy;
    } catch (err) {
      console.error('pushOrders: clone error', err);
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
