const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const fail = (message, status = 400, fields = []) =>
  Object.assign(new Error(message), { status, fields });
export const defaults = () => ({
  businessName: "",
  contactName: "",
  supportContact: "",
  enquiryOwnerId: null,
  contentOwnerId: null,
  fallbackOwnerId: null,
  advisorIds: [],
  timezone: "Australia/Brisbane",
  coverage: [],
  closedDates: [],
  afterHoursMessage: "",
  greeting: "",
  defaultLanguage: "es",
  languages: ["es"],
});
export function revision(value) {
  if (!Number.isInteger(value) || value < 0)
    throw fail("Refresh Settings before saving.");
  return value;
}
function text(value, key, max) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw fail(`Enter a valid ${key}.`, 400, [key]);
  return value.trim();
}
function id(value, key) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw fail("Select a valid team member.", 400, [key]);
  return value;
}
function time(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw fail("Enter valid coverage hours.", 400, ["coverage"]);
  return value;
}
export function configuration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail("Enter assistant settings.");
  const base = defaults();
  if (Object.keys(input).some((k) => !Object.hasOwn(base, k)))
    throw fail("Settings contains unsupported fields.");
  const result = { ...base };
  for (const [key, max] of Object.entries({
    businessName: 160,
    contactName: 160,
    supportContact: 320,
    afterHoursMessage: 1000,
    greeting: 2000,
  }))
    result[key] = text(input[key], key, max);
  for (const key of ["enquiryOwnerId", "contentOwnerId", "fallbackOwnerId"])
    result[key] = id(input[key], key);
  if (!Array.isArray(input.advisorIds) || input.advisorIds.length > 50)
    throw fail("Select up to 50 advisors.", 400, ["advisorIds"]);
  result.advisorIds = [
    ...new Set(
      input.advisorIds.map((v) => {
        const value = id(v, "advisorIds");
        if (!value) throw fail("Select a valid advisor.", 400, ["advisorIds"]);
        return value;
      }),
    ),
  ];
  result.timezone = text(input.timezone, "timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: result.timezone });
  } catch {
    throw fail("Select a valid timezone.", 400, ["timezone"]);
  }
  const allowed = ["es", "en", "pt"];
  if (
    !Array.isArray(input.languages) ||
    !input.languages.length ||
    input.languages.length > 3 ||
    input.languages.some((l) => !allowed.includes(l)) ||
    !input.languages.includes(input.defaultLanguage)
  )
    throw fail("Select supported languages and a default language.", 400, [
      "languages",
      "defaultLanguage",
    ]);
  result.languages = [...new Set(input.languages)];
  result.defaultLanguage = input.defaultLanguage;
  if (!Array.isArray(input.coverage) || input.coverage.length > 28)
    throw fail("Add up to 28 coverage intervals.", 400, ["coverage"]);
  result.coverage = input.coverage
    .map((w) => {
      if (!w || !Number.isInteger(w.day) || w.day < 0 || w.day > 6)
        throw fail("Choose a coverage weekday.", 400, ["coverage"]);
      const start = time(w.start),
        end = time(w.end);
      if (start >= end)
        throw fail("Coverage end must be after its start.", 400, ["coverage"]);
      return { day: w.day, start, end };
    })
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  result.coverage.forEach((w, i) => {
    const prev = result.coverage[i - 1];
    if (prev && prev.day === w.day && w.start < prev.end)
      throw fail("Coverage intervals cannot overlap.", 400, ["coverage"]);
  });
  if (!Array.isArray(input.closedDates) || input.closedDates.length > 100)
    throw fail("Add up to 100 closed dates.", 400, ["closedDates"]);
  result.closedDates = [
    ...new Set(
      input.closedDates.map((v) => {
        if (
          typeof v !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
          !Number.isFinite(Date.parse(v)) ||
          new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) !== v
        )
          throw fail("Enter a valid closed date.", 400, ["closedDates"]);
        return v;
      }),
    ),
  ].sort();
  return result;
}
export const selectedIds = (c) => [
  ...new Set(
    [
      c.enquiryOwnerId,
      c.contentOwnerId,
      c.fallbackOwnerId,
      ...c.advisorIds,
    ].filter(Boolean),
  ),
];
export function publicationIssues(c, eligibleIds) {
  const fields = [
    "businessName",
    "contactName",
    "supportContact",
    "enquiryOwnerId",
    "contentOwnerId",
    "fallbackOwnerId",
    "greeting",
    "afterHoursMessage",
  ].filter((k) => !c[k]);
  if (c.supportContact && !validSupportContact(c.supportContact))
    fields.push("supportContact");
  if (!c.coverage.length) fields.push("coverage");
  if (!c.advisorIds.length) fields.push("advisorIds");
  for (const key of ["enquiryOwnerId", "contentOwnerId", "fallbackOwnerId"])
    if (c[key] && !eligibleIds.has(c[key])) fields.push(key);
  if (c.advisorIds.some((v) => !eligibleIds.has(v))) fields.push("advisorIds");
  return [...new Set(fields)];
}

function validSupportContact(value) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  if (/^[+()\d .-]+$/.test(value) && value.replace(/\D/g, "").length >= 7)
    return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
