const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

export function resolveRelativeWeekday(word: string, publishedAt?: string): string | undefined {
  if (!publishedAt) return undefined;
  const idx = DAYS.indexOf(word.toLowerCase());
  if (idx < 0) return undefined;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return undefined;
  let delta = (idx - d.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0,10);
}

function offsetForDate(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`Invalid calendar date: ${date}`);
  const sample = new Date(Date.UTC(year, month - 1, day, 12));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(sample);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const renderedAsUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  const offsetMinutes = Math.round((renderedAsUtc - sample.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function combineDateTime(
  date: string,
  time?: string,
  timeZone = 'America/New_York',
): string {
  const offset = offsetForDate(date, timeZone);
  if (!time) return `${date}T23:59:00${offset}`;
  const m = time.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return `${date}T23:59:00${offset}`;
  let h = Number(m[1]); const min = Number(m[2] ?? 0); const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${date}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00${offset}`;
}
