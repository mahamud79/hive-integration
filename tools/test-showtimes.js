import { parseShowtimes, parseEventDate } from '../src/parse-showtimes.js';

const names = [
  'The Roxy, Vancouver - Saturday, October 10th 2026 (Door 7:00PM, Start 7:30PM)',
  'Revelry Food+Music Hub, Kelowna - Saturday, September 19th 2026 Late Show (Doors: 9:00PM, Starts: 10:00PM)',
  'The Arrowhead, Calgary- Saturday, October 10th 2026 (Late Show) (Door 9:30PM, Start 10:30PM)',
  'Holiday Inn, Corby - Saturday 19th Sept 2026 (Doors: 6:00PM, Show Starts 7:30PM)',
  'Holiday Inn, Corby - Friday, 6th November 2026 (Doors 6:00 PM, Show Starts 7:30PM)',
  'Ormonde Hotel, Kilkenny - Saturday 19th September 2026 (Doors open: 6:00 pm Start times: 7:30 pm)',
  'Ormonde Hotel, Kilkenny - Saturday 24th October 2026 ( Doors open: 6:00 pm Start times: 7:30 pm)',
  'Club M2, Miami',
];

for (const n of names) {
  const t = parseShowtimes(n);
  const d = parseEventDate(n);
  console.log(
    (d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : 'no-date') +
    '  door=' + (t.door ? t.door.text : '-') +
    '  start=' + (t.start ? t.start.text : '-') +
    '  | ' + n.slice(0, 55)
  );
}
