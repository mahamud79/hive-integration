import { pushEvents } from './hive.js';
import { buildEventId } from './event-id.js';

const name = 'Chelsea Theatre';
const startAt = '2026-07-15T18:00:00Z';

const event = {
  event_id: buildEventId(name, startAt),   // FIX (Problem 1): stable id, not the name
  name,
  event_url: 'https://bingoloco.ca/experiences/chelsea-theatre',
  start_at: startAt,
  end_at: '2026-07-15T23:00:00Z',
  timezone: 'America/Toronto',
  updated_at: new Date().toISOString(),
  venue: { name: 'Chelsea Theatre', city: 'Toronto', state: 'Ontario', country: 'Canada' },
  tiers: [{ tier_id: 'tier_ga', name: 'General Admission', price: 25.0 }],
};

console.log('Pushing event with event_id = ' + event.event_id);

pushEvents([event])
  .then((r) => {
    console.log('');
    console.log('Hive responded ' + r.status + ' (202 = queued for processing).');
    console.log('Response:', JSON.stringify(r.data, null, 2));
  })
  .catch((e) => {
    console.error('');
    console.error('Hive request failed: ' + e.message);
    if (e.response) console.error('Details:', JSON.stringify(e.response, null, 2));
    process.exitCode = 1;
  });
