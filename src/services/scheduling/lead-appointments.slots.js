// Work in real instants. Repeated wall-clock times retain separate UTC IDs;
// nonexistent DST times are never manufactured from a local datetime string.
export function localParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
    day: new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay(),
  };
}
export function filterSlots(calendar, candidates, busy, now) {
  const closed = new Set(calendar.closedDates),
    earliest = Date.parse(now) + calendar.leadTimeMinutes * 60000,
    latest = Date.parse(now) + calendar.bookingWindowDays * 86400000;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendar.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const permitted = (t) => {
    const p = Object.fromEntries(
        formatter.formatToParts(new Date(t)).map((v) => [v.type, v.value]),
      ),
      date = `${p.year}-${p.month}-${p.day}`,
      minute = Number(p.hour) * 60 + Number(p.minute),
      day = new Date(date + "T12:00:00Z").getUTCDay();
    return (
      !closed.has(date) &&
      calendar.weeklyHours.some(
        (w) => w.day === day && minute >= w.startMinute && minute < w.endMinute,
      )
    );
  };
  return candidates
    .filter((slot) => {
      const start = Date.parse(slot.startsAt),
        end = Date.parse(slot.endsAt);
      if (
        start < earliest ||
        end > latest ||
        busy.some(
          (b) => Date.parse(b.startsAt) < end && Date.parse(b.endsAt) > start,
        )
      )
        return false;
      // Every quarter-hour of the appointment must fit working hours. Checking both
      // segment edges also handles DST transitions, midnight and interval breaks.
      for (let t = start; t < end; t += 900000)
        if (!permitted(t) || !permitted(Math.min(t + 900000, end) - 1))
          return false;
      return true;
    })
    .map((s) => ({
      startsAt: new Date(s.startsAt).toISOString(),
      endsAt: new Date(s.endsAt).toISOString(),
    }));
}
