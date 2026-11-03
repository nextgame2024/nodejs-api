import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@jest/globals";

describe("WhatsApp appointment changes migration", () => {
  it("binds bounded change requests to the server-selected appointment and conversation", async () => {
    const sql = await readFile(
      new URL(
        "./migrations/123_whatsapp_appointment_changes.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("lead_appointment_change_requests");
    expect(sql).toContain("expected_version integer NOT NULL");
    expect(sql).toContain("jsonb_array_length(slots) BETWEEN 0 AND 3");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("cancel_stale_appointment_change_requests");
    expect(sql).toContain("assistant_message_outbox_appointment_change_fk");
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|DELETE)/i);
  });
});
