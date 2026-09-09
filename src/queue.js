// Durable Redis-backed queue for Hive writes.
//
// Why: Hive rate-limits (429) and the browser request that carried the
// payload is usually gone by the time we could retry inline. Jobs live in
// Redis, so a restart or a deploy cannot lose a paid order.

import { randomUUID } from 'node:crypto';
import { pushEvents, pushOrders } from './hive.js';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const QUEUE_KEY = process.env.HIVE_QUEUE_KEY || 'hive_queue';
const DEAD_KEY = QUEUE_KEY + '_dead';
const MAX_ATTEMPTS = Number(process.env.HIVE_MAX_ATTEMPTS || 8);
const EVENT_TTL = Number(process.env.HIVE_EVENT_CACHE_TTL || 3600);
const TICK_MS = Number(process.env.HIVE_WORKER_TICK_MS || 1000);

export const queueEnabled = Boolean(REDIS_URL && REDIS_TOKEN);

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error('Queue (Redis) error ' + res.status + ': ' + text);
  }

  return text ? JSON.parse(text) : {};
}

// Records that we already pushed this event recently, so repeated
// begin_checkout fires don't re-push identical events all day.
// True when we have NOT pushed this event recently.
async function needsEventPush(eventId) {
  const out = await redis(['GET', 'hive_event_sent:' + eventId]);

  return out.result == null;
}

// Only called after Hive has accepted the event.
async function markEventSent(eventId) {
  await redis([
    'SET', 'hive_event_sent:' + eventId, '1', 'EX', String(EVENT_TTL),
  ]);
}

async function deliver(job) {
  if (job.kind === 'event') {
    if (!(await needsEventPush(job.data.event_id))) {
      console.log('SKIP event (already sent recently) ' + job.data.event_id);
      return;
    }

    await pushEvents([job.data]);
    await markEventSent(job.data.event_id);
    return;
  }

  // An order job carries both, and the event must land first.
  const { event, order } = job.data;

  if (event) {
    if (await needsEventPush(event.event_id)) {
      await pushEvents([event]);
      await markEventSent(event.event_id);
    }
  }

  await pushOrders([order]);
}


export async function enqueue(kind, data) {
  const job = {
    id: randomUUID(),
    kind,
    data,
    attempts: 0,
    queued_at: new Date().toISOString(),
  };

  await redis([
    'ZADD', QUEUE_KEY, String(Date.now()), JSON.stringify(job),
  ]);

  console.log('QUEUED ' + kind + ' ' + job.id);

  return job.id;
}

async function requeue(job, err) {
  const attempts = job.attempts + 1;
  const label = job.kind + ' ' + job.id + ' (attempt ' + attempts + ')';

  if (attempts >= MAX_ATTEMPTS) {
    await redis([
      'RPUSH', DEAD_KEY,
      JSON.stringify({ ...job, attempts, last_error: err.message }),
    ]);

    console.error('DEAD LETTER ' + label + ': ' + err.message);
    return;
  }

  const retryAfter = Number(err.retryAfter);

  const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : Math.min(1000 * Math.pow(2, attempts), 300000);

  const jitter = Math.floor(Math.random() * 500);

  await redis([
    'ZADD', QUEUE_KEY, String(Date.now() + delayMs + jitter),
    JSON.stringify({ ...job, attempts, last_error: err.message }),
  ]);

  console.warn(
    'REQUEUED ' + label + ' in ' + (delayMs + jitter) + 'ms: ' + err.message
  );
}

async function drainOnce() {
  const out = await redis([
    'ZRANGEBYSCORE', QUEUE_KEY, '-inf', String(Date.now()), 'LIMIT', '0', '5',
  ]);

  const members = out.result || [];

  for (const member of members) {
    // Claim the job. If ZREM returns 0 another tick already took it.
    const claimed = await redis(['ZREM', QUEUE_KEY, member]);

    if (!claimed.result) continue;

    let job;

    try {
      job = JSON.parse(member);
    } catch {
      console.error('Dropping unparseable queue member');
      continue;
    }

    try {
      await deliver(job);
      console.log('DELIVERED ' + job.kind + ' ' + job.id);
    } catch (err) {
      // Validation problems will never succeed; don't retry them forever.
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
        await redis([
          'RPUSH', DEAD_KEY,
          JSON.stringify({ ...job, last_error: err.message, response: err.response || null }),
        ]);

        console.error(
          'DEAD LETTER (permanent ' + err.status + ') ' + job.kind + ' ' + job.id
        );

        continue;
      }

      await requeue(job, err);
    }
  }

  return members.length;
}

export function startWorker() {
  if (!queueEnabled) {
    console.warn(
      'Queue disabled: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. ' +
      'Falling back to inline delivery (writes can be lost on 429).'
    );

    return;
  }

  let running = false;

  setInterval(async () => {
    if (running) return;
    running = true;

    try {
      await drainOnce();
    } catch (err) {
      console.error('Queue worker error: ' + err.message);
    } finally {
      running = false;
    }
  }, TICK_MS);

  console.log('Hive queue worker started (tick ' + TICK_MS + 'ms)');
}

export async function queueDepth() {
  if (!queueEnabled) return null;

  const [pending, dead] = await Promise.all([
    redis(['ZCARD', QUEUE_KEY]),
    redis(['LLEN', DEAD_KEY]),
  ]);

  return { pending: pending.result || 0, dead: dead.result || 0 };
}
