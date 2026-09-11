// Local diagnostic. Reads a Render log file and reports how event ids
// are being derived, plus anything that could produce a duplicate.
//
//   node tools/id-census.js "C:\HiveLogs\hive_logs_COMPLETE_aug25_sep1.txt"

import fs from 'node:fs';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node tools/id-census.js <logfile>');
  process.exit(1);
}

// Render prefixes every line, including JSON interiors.
const raw = fs
  .readFileSync(filePath, 'utf8')
  .replace(/^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\s*/gm, '');

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

const seen = new Map();
const marker = /HIVE OUTGOING (\/events|\/orders):\s*/g;
let match;

while ((match = marker.exec(raw)) !== null) {
  const found = extractJson(raw, match.index);
  if (!found) continue;

  marker.lastIndex = found.end;

  let body;
  try { body = JSON.parse(found.json); } catch { continue; }

  const collected = [
    ...(body.events || []),
    ...(body.orders || []).map((o) => o && o.event).filter(Boolean),
  ];

  for (const ev of collected) {
    if (!ev || !ev.event_id) continue;
    seen.set(ev.event_id + '|' + (ev.start_at || ''), {
      id: ev.event_id,
      name: ev.name || '',
      startAt: ev.start_at || '',
    });
  }
}

const rows = [...seen.values()];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const legacy = rows.filter((r) => !r.id.startsWith('evt_'));
const canonical = rows.filter((r) => r.id.startsWith('evt_'));
const uuidKeyed = canonical.filter((r) => UUID.test(r.id));
const nameKeyed = canonical.filter((r) => !UUID.test(r.id));
const noTz = rows.filter(
  (r) => r.startAt && !/(Z|[+-]\d{2}:?\d{2})$/.test(r.startAt)
);

// Same show name appearing under more than one id = duplicate in progress.
const byName = new Map();
for (const r of rows) {
  if (!r.name) continue;
  if (!byName.has(r.name)) byName.set(r.name, new Set());
  byName.get(r.name).add(r.id);
}
const split = [...byName.entries()].filter(([, ids]) => ids.size > 1);

console.log('distinct id+start pairs : ' + rows.length);
console.log('legacy (bare id)        : ' + legacy.length);
console.log('canonical evt_ ids      : ' + canonical.length);
console.log('  uuid-keyed            : ' + uuidKeyed.length);
console.log('  name-keyed (fallback) : ' + nameKeyed.length);
console.log('start_at with no tz     : ' + noTz.length);
console.log('names under >1 id       : ' + split.length);

if (nameKeyed.length) {
  console.log('\nName-keyed (a rename changes these ids):');
  for (const r of nameKeyed.slice(0, 15)) {
    console.log('  ' + r.id + '  ' + r.name);
  }
}

if (split.length) {
  console.log('\nSame name, multiple ids:');
  for (const [name, ids] of split.slice(0, 15)) {
    console.log('  ' + name);
    for (const id of ids) console.log('      ' + id);
  }
}
