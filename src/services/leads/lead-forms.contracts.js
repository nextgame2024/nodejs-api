import { calendarInput } from "../scheduling/lead-appointments.contracts.js";
import { fail } from "./assistant-settings.contracts.js";
import { text, uuid } from "./lead-records.contracts.js";
export const kinds = [
  "title",
  "subtitle",
  "question",
  "description",
  "checkboxes",
  "list",
  "input",
  "calendar",
  "richtext",
];
export function formInput(input) {
  if (
    !input ||
    Object.keys(input).some((k) => !["name", "typeId", "blocks"].includes(k))
  )
    throw fail("The form contains unsupported fields.");
  const name = text(input.name, "name", 160, true),
    typeId = uuid(input.typeId);
  if (
    !Array.isArray(input.blocks) ||
    !input.blocks.length ||
    input.blocks.length > 100
  )
    throw fail("Add between 1 and 100 form blocks.");
  const ids = new Set();
  const blocks = input.blocks.map((b, i) => {
    if (
      !b ||
      !kinds.includes(b.kind) ||
      Object.keys(b).some(
        (k) =>
          !["id", "kind", "text", "required", "options", "calendar"].includes(
            k,
          ),
      )
    )
      throw fail("Unsupported form block.");
    const id = uuid(b.id);
    if (ids.has(id)) throw fail("Form block IDs must be unique.");
    ids.add(id);
    const value = text(
      b.text ?? "",
      `blocks.${i}`,
      b.kind === "description" ? 20000 : 1000,
      b.kind !== "input" &&
        !["list", "checkboxes", "calendar", "richtext"].includes(b.kind),
    );
    if (typeof b.required !== "boolean")
      throw fail("Select whether the question is required.");
    if (b.kind !== "question" && b.required)
      throw fail("Only questions can be marked required.");
    if (!Array.isArray(b.options) || b.options.length > 50)
      throw fail("Use at most 50 options per field.");
    const options = b.options.map((v) => text(v, `blocks.${i}`, 200, true));
    if (["list", "checkboxes"].includes(b.kind)) {
      if (
        !options.length ||
        new Set(options.map((v) => v.toLowerCase())).size !== options.length
      )
        throw fail("Add distinct, non-empty options.");
    } else if (options.length)
      throw fail("Only lists and checkboxes can contain options.");
    if (
      b.kind === "question" &&
      !["input", "list", "checkboxes", "richtext"].includes(
        input.blocks[i + 1]?.kind,
      )
    )
      throw fail("Place an answer field immediately after each question.");
    let calendar;
    if (b.kind === "calendar") {
      const raw = b.calendar;
      if (
        !raw ||
        Object.keys(raw).some(
          (k) => !["advisorId", "timezone", "weeklyHours"].includes(k),
        )
      )
        throw fail(
          "Configure the calendar advisor, timezone and weekly hours.",
        );
      const checked = calendarInput({
        ...raw,
        expectedRevision: 0,
        closedDates: [],
        slotMinutes: 15,
        leadTimeMinutes: 0,
        bookingWindowDays: 180,
      });
      if (!checked.weeklyHours.length)
        throw fail("Add at least one available day and time.");
      calendar = {
        advisorId: uuid(raw.advisorId),
        timezone: checked.timezone,
        weeklyHours: checked.weeklyHours.map(({ day, start, end }) => ({
          day,
          start,
          end,
        })),
      };
    } else if (b.calendar !== undefined)
      throw fail("Only calendar blocks can contain availability.");
    return {
      id,
      kind: b.kind,
      text: value,
      required: b.required,
      options,
      ...(calendar ? { calendar } : {}),
    };
  });
  if (Buffer.byteLength(JSON.stringify(blocks)) > 200000)
    throw fail("This form is too large. Shorten its descriptions.");
  return { name, typeId, blocks };
}
export function formQuery(q) {
  const page = Number(q.page ?? 1),
    limit = Number(q.limit ?? 25);
  const sort = q.sort ?? "updated",
    direction = q.direction ?? "desc";
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    ![25, 50, 100].includes(limit) ||
    !["name", "type", "updated"].includes(sort) ||
    !["asc", "desc"].includes(direction)
  )
    throw fail("Select valid pagination and sorting.");
  return {
    page,
    limit,
    sort,
    direction,
    q: text(q.q ?? "", "search", 200),
    typeId: q.typeId ? uuid(q.typeId) : null,
  };
}
