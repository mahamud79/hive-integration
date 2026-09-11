// Tolerant extraction of door/start times and date from an event name.
//
// Handles every real-world variant seen across CA, UK, EU and US:
//   "(Door 7:00PM, Start 7:30PM)"
//   "(Doors: 9:00PM, Starts: 10:00PM)"
//   "(Doors 6:00 PM, Show Starts 7:30PM)"
//   "(Doors open: 6:00 pm Start times: 7:30 pm)"
//   "September 19th 2026" / "19th September 2026" / "19th Sept 2026"

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// 7, 7:30, 7.30, with or without space before am/pm, dotted or not.
const TIME = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*([ap])\\.?\\s*m\\.?';

function findTime(text, label) {
  // Up to 25 non-digit chars between the label and its time, which
  // absorbs "open:", "times:", "s ", " - " and similar.
  const m = text.match(new RegExp(label + '[^0-9]{0,25}' + TIME, 'i'));
  if (!m) return null;

  let hours = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') hours += 12;

  const minutes = Number(m[2] || 0);
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes, text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` };
}

export function parseShowtimes(name) {
  const text = String(name || '');

  return {
    door: findTime(text, '\\bdoors?\\b'),
    start: findTime(text, '\\bstarts?\\b'),
  };
}

export function parseEventDate(name) {
  const text = String(name || '');
  const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

  // Month first: "September 19th 2026"
  let m = text.match(
    new RegExp(MONTH + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})', 'i')
  );
  if (m) {
    return { year: Number(m[3]), month: MONTHS[m[1].toLowerCase().slice(0, 3)], day: Number(m[2]) };
  }

  // Day first: "19th September 2026", "6th November 2026"
  m = text.match(
    new RegExp('(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH + '\\.?,?\\s+(\\d{4})', 'i')
  );
  if (m) {
    return { year: Number(m[3]), month: MONTHS[m[2].toLowerCase().slice(0, 3)], day: Number(m[1]) };
  }

  return null;
}
