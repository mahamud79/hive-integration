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
 * - Returns an array of event objects (no wrappers).
 * - Never mutates the original input objects.
 */
function normalizeString(value) {
  if (Array.isArray(value)) {
    const firstValue = value.find(
      item =>
        item !== null &&
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
    throw new Error(
      `${fieldName} must be a valid absolute URL`
    );
  }

  if (
    parsedUrl.protocol !== 'http:' &&
    parsedUrl.protocol !== 'https:'
  ) {
    throw new Error(
      `${fieldName} must use HTTP or HTTPS`
    );
  }

  return parsedUrl;
}

/**
 * Normalize and validate event objects before sending them to Hive.
 *
 * Important:
 * - Invalid events throw an error.
 * - Invalid events are never silently returned or sent to Hive.
 * - Event artwork is normalized to `thumbnail_url`.
 * - Legacy `image_url` is accepted only as an input fallback.
 */
function normalizeEventsForHive(items) {
  return (items || []).map((item, index) => {
    const src =
      item && item.event
        ? item.event
        : item;

    if (
      !src ||
      typeof src !== 'object' ||
      Array.isArray(src)
    ) {
      throw new Error(
        `events[${index}] must be an event object`
      );
    }

    const ev = Object.assign({}, src);

    ev.event_id =
      normalizeString(ev.event_id);

    ev.name =
      normalizeString(ev.name);

    ev.start_at =
      normalizeString(ev.start_at);

    ev.event_url =
      normalizeString(ev.event_url);

    if (!ev.event_id) {
      throw new Error(
        `events[${index}].event_id is required`
      );
    }

    if (!ev.name) {
      throw new Error(
        `events[${index}].name is required`
      );
    }

    if (!ev.start_at) {
      throw new Error(
        `events[${index}].start_at is required`
      );
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

    const parsedEventUrl =
      validateHttpUrl(
        ev.event_url,
        `events[${index}].event_url`
      );

    // Reject a generic experiences-listing URL.
    // Hive needs the public page for this individual event.
    if (
      /\/experiences\/?$/i.test(
        parsedEventUrl.pathname
      )
    ) {
      throw new Error(
        `events[${index}].event_url must be the full individual event URL`
      );
    }

    /*
     * Normalize event artwork to `thumbnail_url`.
     *
     * Prefer the corrected property but accept legacy
     * `image_url` as an input fallback for older callers.
     */
    const thumbnailUrl =
      normalizeString(ev.thumbnail_url) ||
      normalizeString(ev.image_url);

    /*
     * Never allow image_url to reach Hive from this normalizer.
     */
    delete ev.image_url;
    delete ev.thumbnail_url;

    if (thumbnailUrl) {
      validateHttpUrl(
        thumbnailUrl,
        `events[${index}].thumbnail_url`
      );

      ev.thumbnail_url =
        thumbnailUrl;
    }

    return ev;
  });
}

/**
 * Authenticated request to the Hive API.
 *
 * Adds:
 * - Authorization
 * - X-Partner-Id
 *
 * Retries once on 401 in case the access token expired
 * between validation and the actual request.
 */
export async function hiveRequest(
  method,
  path,
  body,
  _retried = false
) {
  const accessToken =
    await getAccessToken();

  // Safe logging: guard against circular structures.
  try {
    console.log(
      'HIVE OUTGOING ' + path + ':',
      JSON.stringify(body, null, 2)
    );
  } catch {
    console.log(
      'HIVE OUTGOING ' +
        path +
        ': <unserializable payload>'
    );
  }

  const res = await fetch(
    `${HIVE_API_BASE}${path}`,
    {
      method,

      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        'X-Partner-Id':
          HIVE_CLIENT_ID,

        'Content-Type':
          'application/json',
      },

      body:
        body
          ? JSON.stringify(body)
          : undefined,
    }
  );

  const text =
    await res.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    data = text;
  }

  /*
   * Retry once after refreshing the token.
   */
  if (
    res.status === 401 &&
    !_retried
  ) {
    await refreshTokens();

    return hiveRequest(
      method,
      path,
      body,
      true
    );
  }

  console.log(
    `HIVE RESPONSE ${method} ${path}: ${res.status}`
  );

  /*
   * Hive ingestion commonly returns 202 Accepted.
   * Any 2xx response is considered successful here.
   */
  if (!res.ok) {
    const err =
      new Error(
        `Hive ${method} ${path} failed (${res.status})`
      );

    err.status =
      res.status;

    err.response =
      data;

    throw err;
  }

  return {
    status: res.status,
    data,
  };
}

/**
 * POST /events
 *
 * Create/update events.
 * Hive upserts using event_id.
 */
export function pushEvents(events) {
  if (
    !Array.isArray(events) ||
    events.length === 0
  ) {
    throw new Error(
      'pushEvents: provide a non-empty array of events'
    );
  }

  if (events.length > 50) {
    throw new Error(
      'pushEvents: max 50 items per batch'
    );
  }

  const normalized =
    normalizeEventsForHive(events);

  return hiveRequest(
    'POST',
    '/events',
    {
      events: normalized,
    }
  );
}

/**
 * POST /orders
 *
 * Create/update orders.
 * Hive upserts using order_id.
 *
 * If an order contains a nested event, normalize that
 * nested event using exactly the same event rules.
 *
 * Do not silently fall back to an invalid event payload.
 */
export function pushOrders(orders) {
  if (
    !Array.isArray(orders) ||
    orders.length === 0
  ) {
    throw new Error(
      'pushOrders: provide a non-empty array of orders'
    );
  }

  if (orders.length > 50) {
    throw new Error(
      'pushOrders: max 50 items per batch'
    );
  }

  const ordersCopy =
    orders.map((order, index) => {
      if (
        !order ||
        typeof order !== 'object' ||
        Array.isArray(order)
      ) {
        throw new Error(
          `orders[${index}] must be an order object`
        );
      }

      let copy;

      try {
        copy =
          JSON.parse(
            JSON.stringify(order)
          );
      } catch {
        throw new Error(
          `orders[${index}] could not be cloned`
        );
      }

      if (copy.event) {
        const [normalizedEvent] =
          normalizeEventsForHive(
            [copy.event]
          );

        copy.event =
          normalizedEvent;
      }

      return copy;
    });

  return hiveRequest(
    'POST',
    '/orders',
    {
      orders: ordersCopy,
    }
  );
}

/**
 * POST /contacts
 *
 * Create/update contacts by email/phone.
 */
export function pushContacts(contacts) {
  if (
    !Array.isArray(contacts) ||
    contacts.length === 0
  ) {
    throw new Error(
      'pushContacts: provide a non-empty array of contacts'
    );
  }

  if (contacts.length > 50) {
    throw new Error(
      'pushContacts: max 50 items per batch'
    );
  }

  return hiveRequest(
    'POST',
    '/contacts',
    {
      contacts,
    }
  );
}