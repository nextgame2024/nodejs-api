import { MAX_FORM_WEEKLY_INTERVALS } from "./lead-forms.contracts.js";
import { calendarInput } from "../scheduling/lead-appointments.contracts.js";
import { filterSlots } from "../scheduling/lead-appointments.slots.js";
export function filterFormSlots(config, slots, now = new Date().toISOString()) {
  const c = calendarInput(
    {
      ...config,
      expectedRevision: 0,
      slotMinutes: 15,
      leadTimeMinutes: 0,
      bookingWindowDays: 180,
      closedDates: [],
    },
    MAX_FORM_WEEKLY_INTERVALS,
  );
  return filterSlots(c, slots, [], now);
}
