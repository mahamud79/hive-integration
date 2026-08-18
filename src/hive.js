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
function normalizeString(value) {
  if (Array.isArray(value)) {
    const firstValue = value.find(
      item => item !== null &&
        item !== undefined &&
        String(item).trim().length > 0
    );

    return firstValue !== undefined
      ? String(firstValue).trim()
      : undefined;
  }

  if (value === null || value === undefined) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized || undefined;
}

function validateHttpUrl(value, fieldName) {
  let parsedUrl;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid absolute URL`);
  }

  if (
    parsedUrl.protocol !== 'http:' &&
    parsedUrl.protocol !== 'https:'
  ) {
    throw new Error(`${fieldName} must use HTTP or HTTPS`);
  }

  return parsedUrl;
}

/**
 * Normalize and validate event objects before sending them to Hive.
 *
 * Important:
 * - Invalid events throw an error.
 * - Invalid events are never silently returned or sent to Hive.
 * - Hive's documented image field is image_url.
 */
function normalizeEventsForHive(items) {
  return (items || []).map((item, index) => {
    const src = item && item.event
      ? item.event
      : item;

    if (
      !src ||
      typeof src !== 'object' ||
      Array.isArray(src)
    ) {
      throw new Error(`events[${index}] must be an event object`);
    }

    const ev = Object.assign({}, src);

    ev.event_id = normalizeString(ev.event_id);
    ev.name = normalizeString(ev.name);
    ev.start_at = normalizeString(ev.start_at);
    ev.event_url = normalizeString(ev.event_url);

    if (!ev.event_id) {
      throw new Error(`events[${index}].event_id is required`);
    }

    if (!ev.name) {
      throw new Error(`events[${index}].name is required`);
    }

    if (!ev.start_at) {
      throw new Error(`events[${index}].start_at is required`);
    }

    if (Number.isNaN(Date.parse(ev.start_at))) {
      throw new Error(
        `events[${index}].start_at must be a valid ISO 8601 date`
      );
    }

    if (!ev.event_url) {
      throw new Error(
        `events[${index}].event_url is required`
      );
    }

    const parsedEventUrl = validateHttpUrl(
      ev.event_url,
      `events[${index}].event_url`
    );

    // Reject a generic experiences-listing URL.
    // Hive needs the public page for this individual event.
    if (/\/experiences\/?$/i.test(parsedEventUrl.pathname)) {
      throw new Error(
        `events[${index}].event_url must be the full individual event URL`
      );
    }

    // Accept either incoming name, but send Hive's documented field.
    /*
 * Hive event artwork is sent as `thumbnail_url`.
 * Accept legacy `image_url` only as an input fallback,
 * but never send `image_url` to Hive.
 */
 const thumbnailUrl =
   normalizeString(ev.thumbnail_url) ||
   normalizeString(ev.image_url);

 delete ev.image_url;
 delete ev.thumbnail_url;

 if (thumbnailUrl) {
   validateHttpUrl(
     thumbnailUrl,
     `events[${index}].thumbnail_url`
   );

   ev.thumbnail_url = thumbnailUrl;
 }

    return ev;
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

  // Log the exact Hive response status for testing and monitoring.
  console.log(`HIVE RESPONSE ${method} ${path}: ${res.status}`);


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
