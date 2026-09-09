// One-off: re-send Hive writes that were lost to 429 rate limits.
//
//   node --env-file=.env src/replay.js <logfile> --dry-run
//   node --env-file=.env src/replay.js <logfile>

import fs from 'node:fs';
import { pushEvents, pushOrders } from './hive.js';
import { withRetry } from './limiter.js';

const [, , filePath, ...flags] = process.argv;
const dryRun = flags.includes('--dry-run');

if (!filePath) {
  console.error('Usage: node src/replay.js <logfile> [--dry-run]');
  process.exit(1);
}

const raw = fs.readFileSync(filePath, 'utf8');

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
  const path = match[1];
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
    if (od && od.event && od.event.event_id) events.set(od.event.event_id, od.event);
  }
}

const eventList = [...events.values()];
const orderList = [...orders.values()];
const completed = orderList.filter((o) => o.status === 'completed');

console.log('Events to replay:  ' + eventList.length);
console.log('Orders to replay:  ' + orderList.length);
console.log('  completed:       ' + completed.length);
console.log('  started:         ' + (orderList.length - completed.length));
console.log(
  'Completed value:   ' +
  completed.reduce((sum, o) => sum + (Number(o.value) || 0), 0).toFixed(2)
);

if (dryRun) {
  console.log('\n--dry-run: nothing sent. Order IDs:');
  console.log(orderList.map((o) => o.order_id + ' ' + o.status).join('\n'));
  process.exit(0);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

for (const batch of chunk(eventList, 25)) {
  const res = await withRetry(() => pushEvents(batch));
  console.log('events batch (' + batch.length + ') -> ' + res.status);
}

for (const batch of chunk(orderList, 25)) {
  const res = await withRetry(() => pushOrders(batch));
  console.log('orders batch (' + batch.length + ') -> ' + res.status);
}

console.log('Replay complete.');
