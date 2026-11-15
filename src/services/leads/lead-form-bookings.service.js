import { calendarInput } from "../scheduling/lead-appointments.contracts.js";
import { filterSlots } from "../scheduling/lead-appointments.slots.js";
export function filterFormSlots(config, slots, now = new Date().toISOString()) {
  const c = calendarInput({
    ...config,
    expectedRevision: 0,
    slotMinutes: 15,
    leadTimeMinutes: 0,
    bookingWindowDays: 180,
    closedDates: [],
  });
  return filterSlots(c, slots, [], now);
}
