import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@jest/globals";

describe("WhatsApp appointment confirmation migration", () => {
  it("binds bounded offers to the tenant, conversation, source event and shared appointment", async () => {
    const sql = await readFile(
      new URL(
        "./migrations/122_whatsapp_appointment_confirmation.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("lead_appointment_offers");
    expect(sql).toContain("jsonb_array_length(slots) BETWEEN 1 AND 3");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("cancel_stale_appointment_offers");
    expect(sql).toContain("assistant_message_outbox_appointment_offer_fk");
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|DELETE)/i);
  });
});
