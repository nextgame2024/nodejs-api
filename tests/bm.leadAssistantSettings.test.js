import { describe, expect, test } from "@jest/globals";
import {
  configuration,
  defaults,
  publicationIssues,
} from "../src/services/leads/assistant-settings.contracts.js";
const owner = "11111111-1111-4111-8111-111111111111";
describe("Assistant Settings validation", () => {
  test("allows incomplete drafts without inventing business or owner values", () => {
    const result = configuration(defaults());
    expect(result.businessName).toBe("");
    expect(result.advisorIds).toEqual([]);
    expect(result.appointmentBookingEnabled).toBe(false);
    expect(publicationIssues(result, new Set())).toEqual(
      expect.arrayContaining([
        "businessName",
        "enquiryOwnerId",
        "coverage",
        "advisorIds",
      ]),
    );
  });
  test("accepts split shifts and rejects overlap, invalid dates and malformed timezones", () => {
    const valid = {
      ...defaults(),
      coverage: [
        { day: 1, start: "09:00", end: "12:00" },
        { day: 1, start: "13:00", end: "17:00" },
      ],
    };
    expect(configuration(valid).coverage).toHaveLength(2);
    expect(() =>
      configuration({
        ...valid,
        coverage: [...valid.coverage, { day: 1, start: "11:00", end: "14:00" }],
      }),
    ).toThrow("overlap");
    expect(() =>
      configuration({ ...valid, closedDates: ["2026-02-30"] }),
    ).toThrow("valid closed date");
    expect(() =>
      configuration({ ...valid, timezone: "invalid/timezone" }),
    ).toThrow("valid timezone");
  });
  test("rejects hidden privilege fields, external IDs, unsupported languages and unbounded input", () => {
    expect(() => configuration({ ...defaults(), companyId: owner })).toThrow(
      "unsupported",
    );
    expect(() =>
      configuration({ ...defaults(), enquiryOwnerId: "not-a-user" }),
    ).toThrow("valid team");
    expect(() =>
      configuration({
        ...defaults(),
        languages: ["fr"],
        defaultLanguage: "fr",
      }),
    ).toThrow("languages");
    expect(() =>
      configuration({ ...defaults(), greeting: "a".repeat(2001) }),
    ).toThrow("greeting");
    expect(() =>
      configuration({
        ...defaults(),
        coverage: Array(29).fill({ day: 1, start: "09:00", end: "17:00" }),
      }),
    ).toThrow("28");
  });
  test("requires a usable public support route before publishing", () => {
    expect(
      publicationIssues(
        { ...defaults(), supportContact: "not a contact" },
        new Set(),
      ),
    ).toContain("supportContact");
    expect(
      publicationIssues(
        { ...defaults(), supportContact: "https://example.test/support" },
        new Set(),
      ),
    ).not.toContain("supportContact");
  });
  test("normalizes duplicates and keeps required owners eligible at publication", () => {
    const c = configuration({
      ...defaults(),
      enquiryOwnerId: owner,
      advisorIds: [owner, owner],
      closedDates: ["2026-12-25", "2026-12-25"],
    });
    expect(c.advisorIds).toEqual([owner]);
    expect(c.closedDates).toHaveLength(1);
    expect(publicationIssues(c, new Set())).toEqual(
      expect.arrayContaining(["enquiryOwnerId", "advisorIds"]),
    );
  });
});
