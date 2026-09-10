// One-off: re-send Hive writes that were lost to 429 rate limits.
//
//   npm run replay -- <logfile> --dry-run
//   npm run replay -- <logfile>
//
// Safe to run more than once: Hive upserts on event_id and order_id.

import fs from 'node:fs';
import { pushEvents, pushOrders } from './hive.js';
import { withRetry } from './limiter.js';

const [, , filePath, ...flags] = process.argv;
const dryRun = flags.includes('--dry-run');

if (!filePath) {
  console.error('Usage: node src/replay.js <logfile> [--dry-run]');
  process.exit(1);
}

const raw = fs
  .readFileSync(filePath, 'utf8')
  .replace(
    /^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\s*/gm,
    ''
  );

// Pull the balanced JSON object that follows a log marker.
function extractJson(text, startIndex) {
  const open = text.indexOf('{', startIndex);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: text.slice(open, i + 1), end: i + 1 };
    }
  }

  return null;
}

const events = new Map();
const orders = new Map();
const marker = /HIVE OUTGOING (\/events|\/orders):\s*/g;
let match;

while ((match = marker.exec(raw)) !== null) {
  const found = extractJson(raw, match.index);

  if (!found) continue;

  // Look only at the log between this call and the next one.
  const tail = raw.slice(found.end, found.end + 4000);
  const nextCall = tail.search(/HIVE OUTGOING /);
  const window = nextCall >= 0 ? tail.slice(0, nextCall) : tail;

  const failed = /failed \((429|500|502|503|504)\)/.test(window);
  const succeeded = /HIVE RESPONSE POST [^\n]*: 2\d\d/.test(window);

  marker.lastIndex = found.end;

  if (!failed || succeeded) continue;

  let body;

  try {
    body = JSON.parse(found.json);
  } catch {
    continue;
  }

  for (const ev of body.events || []) {
    if (ev && ev.event_id) events.set(ev.event_id, ev);
  }

  for (const od of body.orders || []) {
    if (od && od.order_id) orders.set(od.order_id, od);
    if (od && od.event && od.event.event_id) {
      events.set(od.event.event_id, od.event);
    }
  }
}

const eventList = [...events.values()];
const orderList = [...orders.values()];
const completed = orderList.filter((o) => o.status === 'completed');

/*
 * Historical payloads carry no top-level `value` field - only price
 * and quantity per line item - so derive the total from the items.
 */
function orderValue(o) {
  if (Number(o.value) > 0) return Number(o.value);

  return (o.items || []).reduce(
    (sum, i) =>
      sum + (Number(i.price) || 0) * (Number(i.quantity) || 1),
    0
  );
}

console.log('Events to replay:  ' + eventList.length);
console.log('Orders to replay:  ' + orderList.length);
console.log('  completed:       ' + completed.length);
console.log('  started:         ' + (orderList.length - completed.length));
console.log(
  'Completed value:   ' +
  completed.reduce((sum, o) => sum + orderValue(o), 0).toFixed(2)
);

if (!eventList.length && !orderList.length) {
  console.log(
    '\nNothing matched. Check the log actually contains ' +
    '"HIVE OUTGOING" lines followed by a "failed (429)".'
  );

  process.exit(0);
}

if (dryRun) {
  console.log('\n--dry-run: nothing sent.\n');

  for (const o of orderList) {
    console.log(
      o.order_id + '  ' + o.status + '  ' + orderValue(o).toFixed(2)
    );
  }

  process.exit(0);
}

/*
 * One record per request. Batching would let a single bad row
 * reject every good row alongside it.
 *
 * Attempts are kept low: a record that fails local validation can
 * never succeed, and withRetry cannot tell that from a transient
 * error, so we avoid burning a long backoff on it.
 */
let sent = 0;
let failed = 0;

for (const ev of eventList) {
  try {
    const res = await withRetry(() => pushEvents([ev]), 5);
    sent++;
    console.log('event ' + ev.event_id + ' -> ' + res.status);
  } catch (err) {
    failed++;
    console.error('event ' + ev.event_id + ' FAILED: ' + err.message);
  }
}

for (const od of orderList) {
  try {
    const res = await withRetry(() => pushOrders([od]), 5);
    sent++;
    console.log(
      'order ' + od.order_id + ' (' + od.status + ') -> ' + res.status
    );
  } catch (err) {
    failed++;
    console.error('order ' + od.order_id + ' FAILED: ' + err.message);
  }
}

console.log('\nReplay complete. sent=' + sent + ' failed=' + failed);

if (failed) {
  console.log(
    'Re-running is safe - Hive upserts, so successful rows will not double up.'
  );
}
