// Versioned so changes to matching rules can be reviewed before another import.
export const NORMALIZATION_VERSION = 1;
export function normalizeStudentName(value) {
  const original = String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ");
  // Remove complete leading internal codes only, never letters inside a name.
  const name = original.replace(/^(?:[a-z]+\d+\b[\s\-–—]*)+/iu, "").trim();
  return { original, name, key: name.toLocaleLowerCase("en") };
}
export function usernameBase(name) {
  return (
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => word.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean)
      .join(".") || "student"
  );
}
export function validEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}
export function groupContacts(contacts) {
  const groups = new Map();
  for (const contact of contacts) {
    const normalized = normalizeStudentName(contact.legal_name);
    const key = normalized.key || `invalid:${contact.xero_contact_id}`;
    const group = groups.get(key) || {
      key,
      name: normalized.name,
      names: [],
      emails: [],
      contacts: [],
      records: 0,
    };
    group.names.push(normalized.original);
    if (contact.email?.trim())
      group.emails.push(contact.email.trim().toLowerCase());
    group.contacts.push(contact.xero_contact_id);
    group.records += Number(contact.records);
    groups.set(key, group);
  }
  const result = [...groups.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  for (const group of result) {
    group.names = [...new Set(group.names)].sort();
    group.emails = [...new Set(group.emails)].sort();
    // Prefer an existing mixed-case spelling over an all-caps variant. Do not title-case surnames.
    const mixed = group.names
      .map((n) => normalizeStudentName(n).name)
      .find((n) => /[a-z]/.test(n) && /[A-Z]/.test(n));
    if (mixed) group.name = mixed;
  }
  return result;
}
export function candidateReason(group, emailOwners) {
  if (!group.name || !/\p{L}/u.test(group.name) || /^\d/.test(group.name))
    return "Review the student name";
  if (
    /\b(college|institute|university|pty|ltd|academy|academies)\b/i.test(
      group.name,
    )
  )
    return "Confirm this contact is a student, not an organisation";
  if (!group.emails.length) return "Email is missing";
  if (group.emails.length > 1) return "Multiple emails belong to this name";
  if (!validEmail(group.emails[0])) return "Email is invalid";
  if ((emailOwners.get(group.emails[0])?.size ?? 0) > 1)
    return "Email is shared by different names";
  return null;
}
