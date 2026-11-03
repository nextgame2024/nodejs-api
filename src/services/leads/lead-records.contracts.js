import { createHash } from "node:crypto";
import { fail } from "./assistant-settings.contracts.js";
export const stages = ["new", "qualifying", "qualified", "closed"];
export function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw fail("Refresh the record and try again.");
  return value.toLowerCase();
}
export function version(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw fail("Refresh the record before saving.");
  return value;
}
export function text(value, key, max, required = false) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw fail("Check the highlighted fields.", 400, [key]);
  return value.trim();
}
export function leadInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail("Enter the lead details.");
  const keys = [
    "displayName",
    "email",
    "phone",
    "language",
    "interest",
    "location",
    "timeframe",
    "stage",
    "stageReason",
    "assignedTo",
  ];
  if (Object.keys(input).some((k) => !keys.includes(k)))
    throw fail("The lead contains unsupported fields.");
  const result = {};
  for (const [key, max] of Object.entries({
    displayName: 160,
    email: 320,
    phone: 40,
    interest: 500,
    location: 160,
    timeframe: 160,
    stageReason: 1000,
  }))
    result[key] = text(input[key] ?? "", key, max, key === "displayName");
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))
    throw fail("Enter a valid email.", 400, ["email"]);
  if (
    result.phone &&
    (!/^[+()\d .-]{7,40}$/.test(result.phone) ||
      result.phone.replace(/\D/g, "").length < 7 ||
      result.phone.replace(/\D/g, "").length > 15)
  )
    throw fail("Enter a valid contact phone.", 400, ["phone"]);
  if (!["es", "en", "pt"].includes(input.language))
    throw fail("Select a supported language.", 400, ["language"]);
  result.language = input.language;
  result.stage = input.stage ?? "new";
  if (!stages.includes(result.stage))
    throw fail("Select a supported lead stage.", 400, ["stage"]);
  if (["closed", "qualified"].includes(result.stage) && !result.stageReason)
    throw fail("Add a reason for this stage.", 400, ["stageReason"]);
  result.assignedTo =
    input.assignedTo == null || input.assignedTo === ""
      ? null
      : uuid(input.assignedTo);
  return result;
}
export function listQuery(query) {
  const page = Number(query.page ?? 1),
    limit = Number(query.limit ?? 25);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    ![25, 50, 100].includes(limit)
  )
    throw fail("Select a valid page and page size.");
  const sort = query.sort ?? "updated",
    direction = query.direction ?? "desc",
    stage = query.stage ?? "",
    ownership = query.ownership ?? "";
  if (
    !["name", "updated", "stage"].includes(sort) ||
    !["asc", "desc"].includes(direction) ||
    (stage && !stages.includes(stage)) ||
    (ownership &&
      !["paused", "human", "human_requested", "bot"].includes(ownership))
  )
    throw fail("Select valid list filters.");
  return {
    page,
    limit,
    sort,
    direction,
    stage,
    ownership,
    q: text(query.q ?? "", "search", 200),
    assignedTo: query.assignedTo ? uuid(query.assignedTo) : null,
  };
}
export const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function cursor(value) {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{1,19}$/.test(value) ||
    BigInt(value) < 1n ||
    BigInt(value) > 9223372036854775807n
  )
    throw fail("Reload the conversation.");
  return value;
}
