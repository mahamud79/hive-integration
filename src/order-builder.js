// Turns a normalized browser payload into Hive `event` and `order` objects,
// applying the canonical event id so events and orders always line up.

import { buildEventId, buildOccurrenceId } from './event-id.js';

function isNonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNonEmpty(item)) {
          return item.trim();
        }
      }

      continue;
    }

    if (isNonEmpty(value)) {
      return value.trim();
    }
  }

  return '';
}

function cleanEventUrl(rawUrl) {
  const eventUrl = firstNonEmptyString(rawUrl);

  if (!eventUrl) {
    throw new ValidationError(
      'event.url is required. GTM must send the full event page URL.'
    );
  }

  let parsedEventUrl;

  try {
    parsedEventUrl = new URL(eventUrl);
  } catch {
    throw new ValidationError(
      'event.url must be a valid absolute URL'
    );
  }

  if (
    parsedEventUrl.protocol !== 'http:' &&
    parsedEventUrl.protocol !== 'https:'
  ) {
    throw new ValidationError(
      'event.url must use HTTP or HTTPS'
    );
  }

  if (
    /\/experiences\/?$/i.test(
      parsedEventUrl.pathname
    )
  ) {
    throw new ValidationError(
      'event.url must be the full individual event URL, not the generic experiences page'
    );
  }

  // Never save GTM Preview parameters as part of the public event URL.
  [
    'gtm_debug',
    'gtm_auth',
    'gtm_preview',
    'gtm_cookies_win',
  ].forEach((param) => {
    parsedEventUrl.searchParams.delete(param);
  });

  return parsedEventUrl.toString();
}

function cleanThumbnailUrl(rawUrl) {
  const thumbnailUrl =
    firstNonEmptyString(rawUrl);

  if (!thumbnailUrl) {
    return '';
  }

  let parsedThumbnailUrl;

  try {
    parsedThumbnailUrl =
      new URL(thumbnailUrl);
  } catch {
    throw new ValidationError(
      'event.thumbnail_url must be a valid absolute URL'
    );
  }

  if (
    parsedThumbnailUrl.protocol !== 'http:' &&
    parsedThumbnailUrl.protocol !== 'https:'
  ) {
    throw new ValidationError(
      'event.thumbnail_url must use HTTP or HTTPS'
    );
  }

  return parsedThumbnailUrl.toString();
}

/**
 * Build and validate the Hive event object.
 *
 * Expected input:
 * {
 *   event_id,
 *   name,
 *   start_at,
 *   end_at,
 *   url or event_url,
 *   thumbnail_url or legacy image_url,
 *   timezone,
 *   venue,
 *   tiers
 * }
 */
export function buildEventPayload(ev) {
  if (
    !ev ||
    typeof ev !== 'object' ||
    Array.isArray(ev)
  ) {
    throw new ValidationError(
      'event object is required'
    );
  }

  const name =
    firstNonEmptyString(ev.name);

  const startAt =
    firstNonEmptyString(ev.start_at);

  if (!name) {
    throw new ValidationError(
      'event.name is required'
    );
  }

  if (!startAt) {
    throw new ValidationError(
      'event.start_at is required'
    );
  }

  if (Number.isNaN(Date.parse(startAt))) {
    throw new ValidationError(
      'event.start_at must be a valid ISO 8601 date'
    );
  }

  const eventUrl = cleanEventUrl(
    firstNonEmptyString(
      ev.event_url,
      ev.url
    )
  );

  const city =
    ev.venue &&
    typeof ev.venue === 'object' &&
    isNonEmpty(ev.venue.city)
      ? ev.venue.city.trim()
      : undefined;

  /*
   * Occurrence-level event id: source UUID + start date.
   *
   * Easol reuses one product-level UUID across every date of a
   * recurring show, so the UUID alone collapses separate shows into a
   * single Hive event. The date must therefore be part of the key.
   *
   * The name is deliberately NOT part of the key: the same show
   * arrives under several name forms (with and without a trailing
   * date suffix, with and without a theme prefix), which would split
   * one occurrence across multiple ids.
   *
   * buildEventId (name + date) remains the fallback for payloads that
   * carry no source id at all.
   */
  const sourceId = firstNonEmptyString(
    ev.event_id,
    ev.product_id
  );

  const eventId = sourceId
    ? buildOccurrenceId(sourceId, startAt)
    : buildEventId(name, startAt, city);

  const event = {
    event_id: eventId,
    name,
    event_url: eventUrl,
    start_at: startAt,
    updated_at: new Date().toISOString(),
  };

  if (isNonEmpty(ev.end_at)) {
    const endAt = ev.end_at.trim();

    if (Number.isNaN(Date.parse(endAt))) {
      throw new ValidationError(
        'event.end_at must be a valid ISO 8601 date'
      );
    }

    event.end_at = endAt;
  }

  /*
   * Hive requires the event image under `thumbnail_url`.
   * Prefer the corrected GTM property and keep `image_url`
   * only as a backward-compatible input fallback.
   */
  const thumbnailUrl = cleanThumbnailUrl(
    firstNonEmptyString(
      ev.thumbnail_url,
      ev.image_url
    )
  );

  if (thumbnailUrl) {
    event.thumbnail_url = thumbnailUrl;
  }

  /*
   * Never assume a default timezone.
   * Only include it when the source provides the real event timezone.
   */
  if (isNonEmpty(ev.timezone)) {
    event.timezone =
      ev.timezone.trim();
  }

  if (
    ev.venue &&
    typeof ev.venue === 'object' &&
    !Array.isArray(ev.venue) &&
    isNonEmpty(ev.venue.name)
  ) {
    event.venue =
      Object.assign({}, ev.venue);
  }

  if (
    Array.isArray(ev.tiers) &&
    ev.tiers.length
  ) {
    event.tiers = ev.tiers;
  }

  return event;
}

/**
 * Build a Hive order object.
 *
 * @param {object} input {
 *   status,
 *   order_id,
 *   event,
 *   user,
 *   items,
 *   value
 * }
 *
 * status:
 * "started" | "completed" | "cancelled" |
 * "pending" | "partial_payment"
 */
export function buildOrderPayload(input) {
  const {
    status,
    order_id,
    event,
    user,
    items,
    value,
  } = input || {};

  const validStatuses = [
    'started',
    'completed',
    'cancelled',
    'pending',
    'partial_payment',
  ];

  if (!validStatuses.includes(status)) {
    throw new ValidationError(
      'status must be one of: ' +
      validStatuses.join(', ')
    );
  }

  if (!isNonEmpty(order_id)) {
    throw new ValidationError(
      'order_id is required'
    );
  }

  if (
    !user ||
    (
      !isNonEmpty(user.email) &&
      !isNonEmpty(user.phone_number)
    )
  ) {
    throw new ValidationError(
      'user.email or user.phone_number is required'
    );
  }

  if (
    !event ||
    !isNonEmpty(event.name) ||
    !isNonEmpty(event.start_at)
  ) {
    throw new ValidationError(
      'event.name and event.start_at are required to map the order'
    );
  }

  const city =
    event.venue &&
    event.venue.city
      ? event.venue.city
      : undefined;

  /*
   * Must derive identically to buildEventPayload, or orders will
   * reference an event id that does not exist in Hive.
   */
  const sourceId = firstNonEmptyString(
    event.event_id,
    event.product_id
  );

  const eventId = sourceId
    ? buildOccurrenceId(sourceId, event.start_at)
    : buildEventId(
        event.name,
        event.start_at,
        city
      );

  // Normalize items; the live API requires item_id on every line item.
  let normalizedItems;

  if (
    Array.isArray(items) &&
    items.length
  ) {
    normalizedItems = items.map(
      (item, index) => ({
        item_id:
          isNonEmpty(item.item_id)
            ? item.item_id.trim()
            : 'item_' + (index + 1),

        tier_id:
          isNonEmpty(item.tier_id)
            ? item.tier_id.trim()
            : undefined,

        tier_name:
          isNonEmpty(item.tier_name)
            ? item.tier_name.trim()
            : undefined,

        price:
          Number(item.price || 0),

        quantity:
          Number(item.quantity || 1),

        status:
          item.status ||
          (
            status === 'completed'
              ? 'completed'
              : 'started'
          ),
      })
    );
  } else {
    normalizedItems = [
      {
        item_id: 'item_1',
        tier_name: 'General Admission',
        price: Number(value || 0),
        quantity: 1,
        status:
          status === 'completed'
            ? 'completed'
            : 'started',
      },
    ];
  }

  normalizedItems.forEach((item) => {
    Object.keys(item).forEach((key) => {
      if (item[key] === undefined) {
        delete item[key];
      }
    });
  });

  const now =
    new Date().toISOString();

  const order = {
    order_id: order_id.trim(),
    event_id: eventId,
    status,
    user: {},
    items: normalizedItems,

    created_at:
      isNonEmpty(input.created_at)
        ? input.created_at.trim()
        : now,

    updated_at: now,
  };

  if (isNonEmpty(user.email)) {
    order.user.email =
      user.email.trim();
  }

  if (
    isNonEmpty(user.phone_number)
  ) {
    order.user.phone_number =
      user.phone_number.trim();
  }

  if (isNonEmpty(user.first_name)) {
    order.user.first_name =
      user.first_name.trim();
  }

  if (isNonEmpty(user.last_name)) {
    order.user.last_name =
      user.last_name.trim();
  }

  /*
   * Email consent mapping — Hive-confirmed semantics.
   *
   *   checkbox selected      -> send is_email_opt_in: true
   *   checkbox NOT selected  -> OMIT the field entirely
   *
   * Hive updates the contact's subscription state on BOTH true and
   * false. Sending false for a simply-unchecked checkout box can
   * unsubscribe an existing subscriber. Unchecked means "no decision
   * made", not "unsubscribe".
   *
   * false is only ever sent when the caller explicitly flags a real
   * unsubscribe action via user.email_opt_in_explicit === true.
   *
   * Replaces the previous behaviour, which always emitted a boolean
   * and therefore sent false on every non-opted-in order.
   */
  const optInRaw =
    user.is_email_opt_in !== undefined
      ? user.is_email_opt_in
      : user.email_opt_in;

  const optedIn =
    optInRaw === true ||
    optInRaw === 'true' ||
    optInRaw === 1 ||
    optInRaw === '1';

  const optedOut =
    optInRaw === false ||
    optInRaw === 'false' ||
    optInRaw === 0 ||
    optInRaw === '0';

  if (optedIn) {
    order.user.is_email_opt_in = true;
  } else if (
    optedOut &&
    user.email_opt_in_explicit === true
  ) {
    // Genuine explicit unsubscribe action, not an unchecked box.
    order.user.is_email_opt_in = false;
  }
  // Otherwise: field omitted, leaving Hive's existing state untouched.

  if (status === 'completed') {
    order.purchased_at = now;
  }

  return order;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}
