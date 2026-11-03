import { describe, test, expect } from "@jest/globals";
import {
  leadInput,
  listQuery,
  cursor,
} from "../src/services/leads/lead-records.contracts.js";
const base = () => ({ displayName: "Example", language: "es" });
describe("Lead input and paging contracts", () => {
  test("keeps unknown optional facts empty and treats contacts as unverified input", () => {
    const v = leadInput(base());
    expect(v.location).toBe("");
    expect(v.assignedTo).toBeNull();
    expect(v.stage).toBe("new");
  });
  test("does not allow provider state or hidden tenant/ownership fields in lead updates", () => {
    for (const field of [
      "customerId",
      "source",
      "humanOwner",
      "ownership",
      "settingsReleaseId",
    ])
      expect(() => leadInput({ ...base(), [field]: "spoof" })).toThrow(
        "unsupported",
      );
    expect(() => leadInput({ ...base(), stage: "converted" })).toThrow("stage");
  });
  test("requires a reason for manual qualification/closure and validates contact fields", () => {
    expect(() => leadInput({ ...base(), stage: "qualified" })).toThrow(
      "reason",
    );
    expect(() =>
      leadInput({
        ...base(),
        stage: "closed",
        stageReason: "Requested closure",
      }),
    ).not.toThrow();
    expect(() => leadInput({ ...base(), email: "not-an-email" })).toThrow(
      "email",
    );
    expect(() =>
      leadInput({ ...base(), displayName: "a".repeat(161) }),
    ).toThrow("highlighted");
  });
  test("bounds page sizes, sort keys and cursor range", () => {
    expect(listQuery({ page: "2", limit: "25" }).page).toBe(2);
    for (const q of [
      { page: 0 },
      { limit: 10000 },
      { sort: "name;DELETE FROM users" },
      { ownership: "anything" },
    ])
      expect(() => listQuery(q)).toThrow();
    expect(() => cursor("9223372036854775808")).toThrow();
    expect(cursor("123")).toBe("123");
  });
});
