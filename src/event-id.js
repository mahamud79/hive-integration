// Canonical, DETERMINISTIC event id.
//
// This is the single fix for all three Hive data problems:
//   - Problem 1: events were keyed by raw name -> now a clean, stable id.
//   - Problem 2: orders used "evt_generic" -> now reference this same id.
//   - Problem 3: SDK sent different ids for the same show -> same input now
//     always yields the same id, and Hive upserts on it (no duplicates).
//
// The id is derived from the event NAME + START DATE, so we never need to
// store an event id in the database. Same name + date => same id, forever.

export function slugify(value) {
  return (value || '')
    .normalize('NFKD')                  // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')    // strip diacritic marks (fixes mojibake)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')        // any run of non-alphanumerics -> single hyphen
    .replace(/^-+|-+$/g, '');           // trim leading/trailing hyphens
}

/**
 * Build the canonical event id.
 * @param {string} name      Event name, e.g. "Chelsea Theatre"
 * @param {string} startAt   ISO date or datetime, e.g. "2026-07-15T18:00:00Z"
 * @param {string} [city]    Optional — include when name+date alone is not unique
 * @returns {string} e.g. "evt_chelsea-theatre_2026-07-15"
 */
export function buildEventId(name, startAt, city) {
  if (!name) throw new Error('buildEventId: name is required');
  if (!startAt) throw new Error('buildEventId: startAt is required');
  const date = String(startAt).slice(0, 10); // YYYY-MM-DD
  const parts = ['evt', slugify(name)];
  if (city) parts.push(slugify(city));
  parts.push(date);
  return parts.join('_').replace(/_+/g, '_');
}

// Quick self-test: `node src/event-id.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(buildEventId('Chelsea Theatre', '2026-07-15T18:00:00Z'));
  console.log(buildEventId('Twenty Two & Co.', '2026-08-01T18:00:00Z', 'Toronto'));
}
