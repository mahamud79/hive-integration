import { pushOrders } from './hive.js';
import { buildEventId } from './event-id.js';

const eventName = 'Chelsea Theatre';
const startAt = '2026-07-15T18:00:00Z';
const eventId = buildEventId(eventName, startAt);

const now = new Date().toISOString();
const orderId = 'order_' + Date.now();

const startedOrder = {
  order_id: orderId,
  event_id: eventId,                 // FIX (Problem 2): real id, not "evt_generic"
  status: 'started',
  user: { email: 'guest@example.com', first_name: 'Sam', last_name: 'Doe', is_email_opt_in: false },
  items: [
    {
      item_id: 'item_ga',            // REQUIRED by the live API (docs say optional, but it isn't)
      tier_id: 'tier_ga',
      tier_name: 'General Admission',
      price: 25.0,
      quantity: 2,
      status: 'started',
    },
  ],
  created_at: now,
  updated_at: now,
};

const completedOrder = {
  ...startedOrder,
  status: 'completed',
  items: [
    {
      item_id: 'item_ga',
      tier_id: 'tier_ga',
      tier_name: 'General Admission',
      price: 25.0,
      quantity: 2,
      status: 'completed',
    },
  ],
  purchased_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mode = process.argv[2] === 'completed' ? completedOrder : startedOrder;
console.log('Pushing ' + mode.status + ' order ' + mode.order_id + ' -> event_id ' + mode.event_id);

pushOrders([mode])
  .then((r) => {
    console.log('');
    console.log('Hive responded ' + r.status + ' (202 = queued).');
    console.log('Response:', JSON.stringify(r.data, null, 2));
  })
  .catch((e) => {
    console.error('');
    console.error('Hive request failed: ' + e.message);
    if (e.response) console.error('Details:', JSON.stringify(e.response, null, 2));
    process.exitCode = 1;
  });
