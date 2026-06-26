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
export function buildEventPayload(ev) {
  if (!ev || !isNonEmpty(ev.name)) throw new ValidationError('event.name is required');
  if (!isNonEmpty(ev.start_at)) throw new ValidationError('event.start_at is required (ISO 8601)');

  const city = ev.venue && ev.venue.city ? ev.venue.city : undefined;
  const event = {
    event_id: buildEventId(ev.name, ev.start_at, city),
    name: ev.name,
    event_url: ev.url,
    start_at: ev.start_at,
    updated_at: new Date().toISOString(),
  };
  if (isNonEmpty(ev.end_at)) event.end_at = ev.end_at;
  event.timezone = isNonEmpty(ev.timezone) ? ev.timezone : 'America/Toronto';
  if (ev.venue && isNonEmpty(ev.venue.name)) event.venue = ev.venue;
  if (Array.isArray(ev.tiers) && ev.tiers.length) event.tiers = ev.tiers;
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
  const event_id = buildEventId(event.name, event.start_at, city);

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
    order_id,
    event_id,
    status,
    user: {
      email: user.email,
      phone_number: user.phone_number,
      first_name: user.first_name,
      last_name: user.last_name,
      // reflect the ACTUAL consent value; defaults to null if not provided
      is_email_opt_in: typeof user.is_email_opt_in === 'boolean' ? user.is_email_opt_in : null,
    },
    items: normItems,
    created_at: isNonEmpty(input.created_at) ? input.created_at : now,
    updated_at: now,
  };
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
