import { test, expect, jest } from "@jest/globals";
import {
  customerContact,
  firstContactRequest,
  contactRequest,
  captureCustomerContact,
} from "../src/services/messaging/customer-contact.js";
const lead = {
  lead_id: "lead",
  display_name: "Business WhatsApp",
  created_by_identity: "whatsapp",
  email: "",
  language: "en",
};
const conversation = { conversation_id: "conversation" };
test("provider display labels do not qualify as confirmed names; previously supplied names do", async () => {
  const db = {
    query: jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ confirmed: true }] }),
  };
  expect(await customerContact(db, "tenant", lead, conversation)).toEqual({
    hasName: false,
    hasEmail: false,
  });
  expect(await customerContact(db, "tenant", lead, conversation)).toEqual({
    hasName: true,
    hasEmail: false,
  });
});
test("optional contact request is offered once and skipped after ignoring it", async () => {
  const db = {
    query: jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{}] }),
  };
  expect(await firstContactRequest(db, "tenant", lead, conversation)).toContain(
    "keep chatting without",
  );
  expect(
    await firstContactRequest(db, "tenant", lead, conversation),
  ).toBeNull();
  expect(contactRequest("es", {}, true)).toContain("correo es opcional");
});
test("existing name and email suppress collection and explicit combined details persist", async () => {
  const db = { query: jest.fn().mockResolvedValue({ rows: [{}] }) };
  expect(
    await firstContactRequest(
      db,
      "tenant",
      { ...lead, email: "a@example.com" },
      conversation,
    ),
  ).toBeNull();
  const customer = { ...lead };
  await captureCustomerContact(
    db,
    "tenant",
    customer,
    conversation,
    "My name is José Muñoz, jose@example.com",
  );
  expect(customer.display_name).toBe("José Muñoz");
  expect(customer.email).toBe("jose@example.com");
  const count = db.query.mock.calls.length;
  await captureCustomerContact(
    db,
    "tenant",
    customer,
    conversation,
    "I would rather ask about pricing",
  );
  expect(db.query).toHaveBeenCalledTimes(count);
});
