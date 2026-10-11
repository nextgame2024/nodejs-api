import { describe, expect, test } from "@jest/globals";
import {
  groupContacts,
  normalizeStudentName,
  candidateReason,
  usernameBase,
} from "../src/services/bm.studentUserSync.normalization.js";

describe("Student import identity normalization", () => {
  test("deduplicates the four supplied invoices into two people", () => {
    const names = [
      "S15 - Fabian Ernesto Bohorquez Ramirez",
      "S15 - S40 Fabian Ernesto Bohorquez Ramirez",
      "S15 - Fabian Andres Lopez Patino",
      "S15 - S40 Fabian Andres Lopez Patino",
    ];
    const groups = groupContacts(
      names.map((legal_name, i) => ({
        legal_name,
        xero_contact_id: String(i),
        records: 1,
      })),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.name)).toEqual([
      "Fabian Andres Lopez Patino",
      "Fabian Ernesto Bohorquez Ramirez",
    ]);
    expect(
      groups.every((g) => g.contacts.length === 2 && g.records === 2),
    ).toBe(true);
  });
  test.each([
    "M30 MELIZA VELEZ PUERTA",
    "C90 - MELIZA VELEZ PUERTA",
    "O10 MELIZA VELEZ PUERTA",
    "S10-S11-C31-B21 MELIZA VELEZ PUERTA",
    " s15 – S40   MELIZA  VELEZ PUERTA ",
  ])("normalizes reusable prefix chains: %s", (name) => {
    expect(normalizeStudentName(name).key).toBe("meliza velez puerta");
  });
  test("preserves real names, accents, embedded digits and display casing", () => {
    expect(normalizeStudentName("  María   O’Neill ").name).toBe(
      "María O’Neill",
    );
    expect(normalizeStudentName("Sandra Smith").name).toBe("Sandra Smith");
    expect(normalizeStudentName("Mary S15 Smith").name).toBe("Mary S15 Smith");
    expect(
      groupContacts([
        { legal_name: "C90 JANE DOE", records: 1 },
        { legal_name: "s10 Jane Doe", records: 1 },
      ])[0].name,
    ).toBe("Jane Doe");
  });
  test("handles one-word usernames and normalizes username accents", () => {
    expect(usernameBase("Fabian Andres Lopez Patino")).toBe("fabian.andres");
    expect(usernameBase("María")).toBe("maria");
  });
  test("reports unsafe candidates instead of guessing an email or person", () => {
    expect(
      candidateReason({ name: "Jane Doe", emails: [] }, new Map()),
    ).toContain("missing");
    expect(
      candidateReason(
        { name: "Jane Doe", emails: ["a@x.com", "b@x.com"] },
        new Map(),
      ),
    ).toContain("Multiple");
    expect(
      candidateReason(
        { name: "Jane Doe", emails: ["a@x.com"] },
        new Map([["a@x.com", new Set(["jane", "john"])]]),
      ),
    ).toContain("shared");
    expect(
      candidateReason(
        { name: "Greenwich College", emails: ["a@x.com"] },
        new Map(),
      ),
    ).toContain("organisation");
  });
});
