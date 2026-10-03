// Local diagnostic: detail behind the census counts.
//   node tools/id-detail.js "C:\HiveLogs\hive_logs_COMPLETE_aug25_sep1.txt"

import fs from 'node:fs';

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: node tools/id-detail.js <logfile>'); process.exit(1); }

const raw = fs.readFileSync(filePath, 'utf8')
  .replace(/^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\s*/gm, '');

function extractJson(text, startIndex) {
  const open = text.indexOf('{', startIndex);
  if (open < 0) return null;
  let depth = 0, inString = false, escaped = false;
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
    else if (ch === '}') { depth--; if (depth === 0) return { json: text.slice(open, i + 1), end: i + 1 }; }
  }
  return null;
}

const rows = new Map();
const marker = /HIVE OUTGOING (\/events|\/orders):\s*/g;
let match;

while ((match = marker.exec(raw)) !== null) {
  const found = extractJson(raw, match.index);
  if (!found) continue;
  marker.lastIndex = found.end;

  let body;
  try { body = JSON.parse(found.json); } catch { continue; }

  const list = [
    ...(body.events || []),
    ...(body.orders || []).map((o) => o && o.event).filter(Boolean),
  ];

  for (const ev of list) {
    if (!ev || !ev.event_id) continue;
    rows.set(ev.event_id + '|' + (ev.start_at || ''), {
      id: ev.event_id,
      name: ev.name || '(no name)',
      startAt: ev.start_at || '',
      tz: ev.timezone || '',
    });
  }
}

const all = [...rows.values()];

// 1. Same name under more than one id, with dates, to judge duplicates.
const byName = new Map();
for (const r of all) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}

console.log('=== Same name, multiple ids ===');
for (const [name, group] of byName) {
  const ids = new Set(group.map((r) => r.id));
  if (ids.size < 2) continue;

  const dates = new Set(group.map((r) => r.startAt.slice(0, 10)));
  const verdict = dates.size < group.length
    ? 'SAME DATE -> true duplicate'
    : 'different dates -> likely legitimate';

  console.log('\n' + name + '   [' + verdict + ']');
  for (const r of group) {
    console.log('   ' + r.startAt + '   ' + r.id);
  }
}

// 2. The records that carry a timezone suffix.
console.log('\n=== start_at WITH timezone suffix ===');
for (const r of all) {
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(r.startAt)) {
    console.log('   ' + r.startAt + '   tzfield=' + (r.tz || '-') + '   ' + r.name);
  }
}

// 3. One source id appearing under two different derived dates.
console.log('\n=== same id, multiple dates ===');
const byId = new Map();
for (const r of all) {
  if (!byId.has(r.id)) byId.set(r.id, new Set());
  byId.get(r.id).add(r.startAt.slice(0, 10));
}
let none = true;
for (const [id, dates] of byId) {
  if (dates.size > 1) { none = false; console.log('   ' + id + '  ' + [...dates].join(', ')); }
}
if (none) console.log('   none');
