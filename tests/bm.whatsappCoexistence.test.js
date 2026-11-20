import { test, expect, jest } from "@jest/globals";
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
jest.unstable_mockModule(
  "../src/services/messaging/whatsapp-channel.service.js",
  () => ({ receiveEvents: jest.fn() }),
);
const { createWhatsAppWebhookRouter } = await import(
  "../src/routes/whatsapp.webhook.routes.js"
);
const base = {
  id: "sophia_ai",
  ready: true,
  customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  phoneNumberId: "123456",
  businessAccountId: "654321",
  appSecret: "app-secret-123456789",
  verifyToken: "verify-token-123456789",
};
const real = {
  ...base,
  id: "sophia_ai_real",
  phoneNumberId: "987654",
  businessAccountId: "456789",
  coexistence: true,
};
const sign = (b) =>
  "sha256=" + createHmac("sha256", base.appSecret).update(b).digest("hex");
test("routes signed coexistence synchronization and lifecycle events from the existing app callback", async () => {
  const capture = jest.fn(),
    receive = jest.fn();
  const app = express().use(
    createWhatsAppWebhookRouter({
      profiles: async () => [base, real],
      capture,
      receive,
    }),
  );
  const b = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "partner-business",
        changes: [
          {
            field: "account_update",
            value: {
              event: "PARTNER_REMOVED",
              waba_info: { waba_id: real.businessAccountId },
            },
          },
        ],
      },
      {
        id: real.businessAccountId,
        changes: [
          {
            field: "history",
            value: {
              metadata: { phone_number_id: real.phoneNumberId },
              history: [{ errors: [{ code: 2593109 }] }],
            },
          },
        ],
      },
    ],
  });
  await request(app)
    .post("/webhooks/whatsapp/sophia_ai")
    .type("json")
    .send(b)
    .expect(401);
  expect(capture).not.toHaveBeenCalled();
  await request(app)
    .post("/webhooks/whatsapp/sophia_ai")
    .type("json")
    .set("x-hub-signature-256", sign(b))
    .send(b)
    .expect(200);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][0].id).toBe(real.id);
  expect(capture.mock.calls[0][1]).toHaveLength(2);
  expect(receive).not.toHaveBeenCalled();
  capture.mockRejectedValueOnce(Error("database unavailable"));
  await request(app)
    .post("/webhooks/whatsapp/sophia_ai")
    .type("json")
    .set("x-hub-signature-256", sign(b))
    .send(b)
    .expect(503);
});
test("rejects signed events for an unconfigured account or wrong real phone", async () => {
  const capture = jest.fn(),
    receive = jest.fn();
  const app = express().use(
    createWhatsAppWebhookRouter({
      profiles: async () => [base, real],
      capture,
      receive,
    }),
  );
  for (const [account, phone] of [
    ["unknown", real.phoneNumberId],
    [real.businessAccountId, "unknown"],
  ]) {
    const b = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: account,
          changes: [
            {
              field: "history",
              value: { metadata: { phone_number_id: phone }, history: [] },
            },
          ],
        },
      ],
    });
    await request(app)
      .post("/webhooks/whatsapp/sophia_ai_real")
      .type("json")
      .set("x-hub-signature-256", sign(b))
      .send(b)
      .expect(400);
  }
  expect(capture).not.toHaveBeenCalled();
  expect(receive).not.toHaveBeenCalled();
});
