// Turns a normalized browser payload into Hive `event` and `order` objects,
// applying the canonical event id so events and orders always line up.


import { buildEventId } from './event-id.js';

function isNonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Build a Hive event object from the data the checkout page already has.
 * @param {object} ev { name, start_at, end_at, url, timezone, venue, tiers }
 */
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
 *   image_url or thumbnail_url,
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
    throw new ValidationError('event object is required');
  }

  const name = isNonEmpty(ev.name)
    ? ev.name.trim()
    : '';

  const startAt = isNonEmpty(ev.start_at)
    ? ev.start_at.trim()
    : '';

  const eventUrl = isNonEmpty(ev.event_url)
    ? ev.event_url.trim()
    : isNonEmpty(ev.url)
      ? ev.url.trim()
      : '';

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

  if (/\/experiences\/?$/i.test(parsedEventUrl.pathname)) {
    throw new ValidationError(
      'event.url must be the full individual event URL, not the generic experiences page'
    );
  }

  const city =
    ev.venue && isNonEmpty(ev.venue.city)
      ? ev.venue.city.trim()
      : undefined;

  const eventId = isNonEmpty(ev.event_id)
    ? ev.event_id.trim()
    : buildEventId(name, startAt, city);

  const event = {
    event_id: eventId,
    name,
    event_url: eventUrl,
    start_at: startAt,
    updated_at: new Date().toISOString(),
  };

  if (isNonEmpty(ev.end_at)) {
    event.end_at = ev.end_at.trim();
  }

  /*
   * Hive's documented event image property is image_url.
   * Accept thumbnail_url from GTM temporarily, but translate it.
   */
  const imageUrl = isNonEmpty(ev.image_url)
    ? ev.image_url.trim()
    : isNonEmpty(ev.thumbnail_url)
      ? ev.thumbnail_url.trim()
      : '';

  if (imageUrl) {
    let parsedImageUrl;

    try {
      parsedImageUrl = new URL(imageUrl);
    } catch {
      throw new ValidationError(
        'event.image_url must be a valid absolute URL'
      );
    }

    if (
      parsedImageUrl.protocol !== 'http:' &&
      parsedImageUrl.protocol !== 'https:'
    ) {
      throw new ValidationError(
        'event.image_url must use HTTP or HTTPS'
      );
    }

    event.image_url = imageUrl;
  }

  /*
   * Never assume America/Toronto.
   * Only include timezone when GTM sends the real event timezone.
   */
  if (isNonEmpty(ev.timezone)) {
    event.timezone = ev.timezone.trim();
  }

  if (
    ev.venue &&
    typeof ev.venue === 'object' &&
    isNonEmpty(ev.venue.name)
  ) {
    event.venue = Object.assign({}, ev.venue);
  }

  if (Array.isArray(ev.tiers) && ev.tiers.length) {
    event.tiers = ev.tiers;
  }

  return event;
}

/**
 * Build a Hive order object.
 * @param {object} input {
 *   status, order_id, event, user, items, value
 * }
 *   status   : "started" (abandoned cart) | "completed" | "cancelled" | "pending" | "partial_payment"
 *   order_id : stable id you generated in the browser (same id for started -> completed)
 *   event    : same shape as buildEventPayload input
 *   user     : { email, phone_number, first_name, last_name, is_email_opt_in, ... }
 *   items    : [{ item_id, tier_id, tier_name, price, quantity, status }]
 *   value    : optional order total (used to synthesize an item if none provided)
 */
export function buildOrderPayload(input) {
  const { status, order_id, event, user, items, value } = input || {};

  const validStatuses = ['started', 'completed', 'cancelled', 'pending', 'partial_payment'];
  if (!validStatuses.includes(status)) {
    throw new ValidationError('status must be one of: ' + validStatuses.join(', '));
  }
  if (!isNonEmpty(order_id)) throw new ValidationError('order_id is required');
  if (!user || (!isNonEmpty(user.email) && !isNonEmpty(user.phone_number))) {
    throw new ValidationError('user.email or user.phone_number is required');
  }
  if (!event || !isNonEmpty(event.name) || !isNonEmpty(event.start_at)) {
    throw new ValidationError('event.name and event.start_at are required to map the order');
  }

  const city = event.venue && event.venue.city ? event.venue.city : undefined;
  const event_id = isNonEmpty(event.event_id)
  ? event.event_id.trim()
  : buildEventId(event.name, event.start_at, city);

  // Normalize items; the live API REQUIRES item_id on each line item.
  let normItems;
  if (Array.isArray(items) && items.length) {
    normItems = items.map((it, i) => ({
      item_id: isNonEmpty(it.item_id) ? it.item_id : 'item_' + (i + 1),
      tier_id: it.tier_id,
      tier_name: it.tier_name,
      price: Number(it.price || 0),
      quantity: Number(it.quantity || 1),
      status: it.status || (status === 'completed' ? 'completed' : 'started'),
    }));
  } else {
    // Abandoned carts often have no line items yet — synthesize one from value.
    normItems = [{
      item_id: 'item_1',
      tier_name: 'General Admission',
      price: Number(value || 0),
      quantity: 1,
      status: status === 'completed' ? 'completed' : 'started',
    }];
  }

  const now = new Date().toISOString();
  const order = {
    order_id: order_id.trim(),
    event_id,
    status,
    user: {},
    items: normItems,
    created_at: isNonEmpty(input.created_at) ? input.created_at : now,
    updated_at: now,
  };

  // Only add user fields if they actually have data
  if (isNonEmpty(user.email)) order.user.email = user.email.trim();
  if (isNonEmpty(user.phone_number)) order.user.phone_number = user.phone_number.trim();
  if (isNonEmpty(user.first_name)) order.user.first_name = user.first_name.trim();
  if (isNonEmpty(user.last_name)) order.user.last_name = user.last_name.trim();
  
  // Hive requires this to be a boolean, never null/undefined
  order.user.is_email_opt_in = (user.is_email_opt_in === true);

  if (status === 'completed') order.purchased_at = now;

  // Drop undefined user subfields so we don't send empty keys.
  Object.keys(order.user).forEach((k) => order.user[k] === undefined && delete order.user[k]);

  return order;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}
