/** The hour of the day (0-23) at `now` in `timeZone`, e.g. America/New_York. Handles DST. */
export function localHour(now, timeZone) {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now))
    .find((p) => p.type === "hour").value;
  return Number(hour);
}
