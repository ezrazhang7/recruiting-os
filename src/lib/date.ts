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

export function combineDateTime(date: string, time?: string): string {
  if (!time) return `${date}T23:59:00-04:00`;
  const m = time.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return `${date}T23:59:00-04:00`;
  let h = Number(m[1]); const min = Number(m[2] ?? 0); const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${date}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00-04:00`;
}
