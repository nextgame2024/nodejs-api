import { describe, test, expect } from "@jest/globals";
import {
  calendarInput,
  date,
  zone,
  bookingInput,
  listInput,
} from "../src/services/scheduling/lead-appointments.contracts.js";
import {
  filterSlots,
  localParts,
} from "../src/services/scheduling/lead-appointments.slots.js";
const c = {
  timezone: "America/New_York",
  slotMinutes: 30,
  leadTimeMinutes: 0,
  bookingWindowDays: 180,
  weeklyHours: [{ day: 0, startMinute: 0, endMinute: 240 }],
  closedDates: [],
};
const series = (start, end) => {
  const r = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += 900000)
    r.push({
      startsAt: new Date(t).toISOString(),
      endsAt: new Date(t + 1800000).toISOString(),
    });
  return r;
};
describe("Lead appointment contracts and timezone slots", () => {
  test("rejects invalid dates, timezones, oversized ranges, durations and overlapping intervals", () => {
    for (const d of ["2026-02-30", "2026-13-01", "2026-1-1"])
      expect(() => date(d)).toThrow();
    expect(() => zone("Wrong/Zone")).toThrow();
    expect(() =>
      listInput({ start: "2026-01-01", end: "2026-12-31", timezone: "UTC" }),
    ).toThrow();
    expect(() =>
      calendarInput({
        expectedRevision: 0,
        timezone: "UTC",
        slotMinutes: 31,
        leadTimeMinutes: 0,
        bookingWindowDays: 30,
        weeklyHours: [],
        closedDates: [],
      }),
    ).toThrow();
  });
  test("spring-forward never offers nonexistent local times", () => {
    const slots = filterSlots(
      c,
      series("2027-03-14T05:00:00Z", "2027-03-14T08:00:00Z"),
      [],
      "2027-03-01T00:00:00Z",
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(
      slots.every(
        (s) => Math.floor(localParts(s.startsAt, c.timezone).minute / 60) !== 2,
      ),
    ).toBe(true);
  });
  test("fall-back retains distinct UTC choices for repeated customer times", () => {
    const slots = filterSlots(
      c,
      series("2027-11-07T04:00:00Z", "2027-11-07T09:00:00Z"),
      [],
      "2027-11-01T00:00:00Z",
    );
    const repeated = slots.filter(
      (s) => localParts(s.startsAt, c.timezone).minute === 60,
    );
    expect(repeated).toHaveLength(2);
    expect(repeated[0].startsAt).not.toBe(repeated[1].startsAt);
  });
  test("breaks, days off, minimum notice and overlaps exclude whole appointments", () => {
    const cal = {
      ...c,
      timezone: "UTC",
      weeklyHours: [
        { day: 1, startMinute: 540, endMinute: 600 },
        { day: 1, startMinute: 660, endMinute: 720 },
      ],
    };
    const candidates = series("2026-11-09T09:00:00Z", "2026-11-09T12:00:00Z");
    let slots = filterSlots(cal, candidates, [], "2026-11-01T00:00:00Z");
    expect(slots.some((s) => s.startsAt === "2026-11-09T09:45:00.000Z")).toBe(
      false,
    );
    expect(
      filterSlots(
        { ...cal, closedDates: ["2026-11-09"] },
        candidates,
        [],
        "2026-11-01T00:00:00Z",
      ),
    ).toHaveLength(0);
    expect(
      filterSlots(
        { ...cal, leadTimeMinutes: 60 },
        candidates,
        [],
        "2026-11-09T11:00:00Z",
      ),
    ).toHaveLength(0);
    slots = filterSlots(
      cal,
      candidates,
      [{ startsAt: "2026-11-09T09:00:00Z", endsAt: "2026-11-09T09:30:00Z" }],
      "2026-11-01T00:00:00Z",
    );
    expect(slots.some((s) => s.startsAt === "2026-11-09T09:30:00.000Z")).toBe(
      true,
    );
  });
  test("closed dates follow the advisor day even when the visitor is on the previous date", () => {
    const slot = {
      startsAt: "2026-11-09T23:00:00Z",
      endsAt: "2026-11-09T23:30:00Z",
    };
    const cal = {
      ...c,
      timezone: "Australia/Brisbane",
      weeklyHours: [{ day: 2, startMinute: 540, endMinute: 1020 }],
    };
    expect(localParts(slot.startsAt, cal.timezone).date).toBe("2026-11-10");
    expect(
      filterSlots(
        { ...cal, closedDates: ["2026-11-09"] },
        [slot],
        [],
        "2026-11-01T00:00:00Z",
      ),
    ).toHaveLength(1);
    expect(
      filterSlots(
        { ...cal, closedDates: ["2026-11-10"] },
        [slot],
        [],
        "2026-11-01T00:00:00Z",
      ),
    ).toHaveLength(0);
  });
});
