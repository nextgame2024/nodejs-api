import { fail } from "../leads/assistant-settings.contracts.js";
import { uuid, version, text } from "../leads/lead-records.contracts.js";
export { uuid, version };
export function zone(value) {
  if (typeof value !== "string" || value.length > 100)
    throw fail("Select a valid timezone.", 400, ["timezone"]);
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw fail("Select a valid timezone.", 400, ["timezone"]);
  }
  return value;
}
export function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw fail("Select a valid date.", 400, ["date"]);
  return value;
}
function minutes(value, end = false) {
  if (end && value === "24:00") return 1440;
  if (
    typeof value !== "string" ||
    !/^([01]\d|2[0-3]):(00|15|30|45)$/.test(value)
  )
    throw fail("Choose working hours in 15-minute steps.", 400, [
      "weeklyHours",
    ]);
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}
export function calendarInput(input) {
  if (
    !input ||
    !Array.isArray(input.weeklyHours) ||
    input.weeklyHours.length > 28 ||
    !Array.isArray(input.closedDates) ||
    input.closedDates.length > 100
  )
    throw fail("Add up to 28 working intervals and 100 closed dates.", 400, [
      "weeklyHours",
      "closedDates",
    ]);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw fail("Reload availability before saving.", 409);
  if (
    ![15, 30, 45, 60].includes(input.slotMinutes) ||
    !Number.isInteger(input.leadTimeMinutes) ||
    input.leadTimeMinutes < 0 ||
    input.leadTimeMinutes > 10080 ||
    !Number.isInteger(input.bookingWindowDays) ||
    input.bookingWindowDays < 1 ||
    input.bookingWindowDays > 180
  )
    throw fail("Check appointment duration, notice and booking window.", 400, [
      "slotMinutes",
      "leadTimeMinutes",
      "bookingWindowDays",
    ]);
  const hours = input.weeklyHours
    .map((w) => {
      if (!w || !Number.isInteger(w.day) || w.day < 0 || w.day > 6)
        throw fail("Select a valid weekday.", 400, ["weeklyHours"]);
      const start = minutes(w.start),
        end = minutes(w.end, true);
      if (start >= end)
        throw fail("Working hours must end after they start.", 400, [
          "weeklyHours",
        ]);
      return {
        day: w.day,
        start: w.start,
        end: w.end,
        startMinute: start,
        endMinute: end,
      };
    })
    .sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
  for (let i = 1; i < hours.length; i++)
    if (
      hours[i].day === hours[i - 1].day &&
      hours[i].startMinute < hours[i - 1].endMinute
    )
      throw fail(
        "Working intervals must not overlap. Leave a gap for breaks.",
        400,
        ["weeklyHours"],
      );
  return {
    timezone: zone(input.timezone),
    slotMinutes: input.slotMinutes,
    leadTimeMinutes: input.leadTimeMinutes,
    bookingWindowDays: input.bookingWindowDays,
    weeklyHours: hours,
    closedDates: [...new Set(input.closedDates.map(date))].sort(),
    expectedRevision: input.expectedRevision,
  };
}
export function bookingInput(input, action) {
  if (!input || typeof input !== "object")
    throw fail("Enter appointment details.");
  const result = {
    requestKey: uuid(input.requestKey),
    leadId: uuid(input.leadId),
  };
  if (action !== "book")
    result.expectedVersion = version(input.expectedVersion);
  if (action !== "cancel") {
    const raw = input.startsAt;
    if (
      typeof raw !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        raw,
      ) ||
      !Number.isFinite(Date.parse(raw))
    )
      throw fail("Select an available appointment time.", 400, ["slot"]);
    date(raw.slice(0, 10));
    result.startsAt = new Date(raw).toISOString();
    result.advisorId = uuid(input.advisorId);
    result.timezone = zone(input.timezone);
    result.calendarRevision = version(input.calendarRevision);
    result.description = text(input.description ?? "", "description", 1000);
  }
  return result;
}
export function listInput(q) {
  const start = date(q.start),
    end = date(q.end),
    timezone = zone(q.timezone);
  if (start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 92)
    throw fail("Select a range of no more than 93 days.");
  const page = Number(q.page ?? 1),
    limit = Number(q.limit ?? 25);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000 ||
    ![25, 50, 100].includes(limit)
  )
    throw fail("Select a valid page and page size.");
  if (
    !["startsAt", "lead", "status"].includes(q.sort ?? "startsAt") ||
    !["asc", "desc"].includes(q.direction ?? "asc")
  )
    throw fail("Select a valid sort order.");
  if (q.status && !["confirmed", "cancelled"].includes(q.status))
    throw fail("Select a valid status.");
  return {
    start,
    end,
    timezone,
    page,
    limit,
    sort: q.sort ?? "startsAt",
    direction: q.direction ?? "asc",
    advisorId: q.advisorId ? uuid(q.advisorId) : null,
    leadId: q.leadId ? uuid(q.leadId) : null,
    status: q.status || null,
  };
}
