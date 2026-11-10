/**
 * Which "sending day" a moment belongs to. A sending day starts at resetHour
 * local time in timeZone, so with resetHour 12 in America/New_York, 11:59am on
 * Nov 10 is still the Nov 9 day and 12:00pm starts the Nov 10 day. Returns
 * "YYYY-MM-DD", which sorts chronologically as a string. DST is handled by Intl.
 */
export function periodKey(now, timeZone, resetHour) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now))) {
    parts[type] = value;
  }
  let day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  if (Number(parts.hour) < resetHour) day -= 24 * 60 * 60 * 1000;
  return new Date(day).toISOString().slice(0, 10);
}
