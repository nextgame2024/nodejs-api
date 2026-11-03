import { describe, test, expect, jest } from "@jest/globals";
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import {
  verifySignature,
  verifyToken,
  normalizePayload,
} from "../src/adapters/whatsapp/inbound.js";
import { channelProfiles } from "../src/services/messaging/channel-profiles.js";
jest.unstable_mockModule(
  "../src/services/messaging/whatsapp-channel.service.js",
  () => ({ receiveEvents: jest.fn() }),
);
const { createWhatsAppWebhookRouter } = await import(
  "../src/routes/whatsapp.webhook.routes.js"
);
const profile = {
  id: "test_number",
  customerId: "11111111-1111-4111-8111-111111111111",
  businessAccountId: "123456",
  phoneNumberId: "654321",
  appSecret: "test-app-secret-long",
  verifyToken: "test-verify-token-long",
  ready: true,
};
const message = (overrides = {}) => ({
  from: "61412345678",
  id: "wamid.test",
  timestamp: "1793664000",
  type: "text",
  text: { body: "Hello 😊" },
  ...overrides,
});
const payload = (messages = [message()]) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: profile.businessAccountId,
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: profile.phoneNumberId },
            contacts: [{ wa_id: "61412345678", profile: { name: "Example" } }],
            messages,
          },
        },
      ],
    },
  ],
});
const body = (p) => Buffer.from(JSON.stringify(p));
const sign = (v) =>
  "sha256=" + createHmac("sha256", profile.appSecret).update(v).digest("hex");
describe("Official WhatsApp receive boundary", () => {
  test("checks the exact original UTF-8 bytes in constant time and rejects malformed signatures", () => {
    const b = body(payload());
    expect(verifySignature(b, sign(b), profile.appSecret)).toBe(true);
    expect(
      verifySignature(
        Buffer.concat([b, Buffer.from(" ")]),
        sign(b),
        profile.appSecret,
      ),
    ).toBe(false);
    for (const s of [
      undefined,
      "sha256=00",
      "sha1=" + "a".repeat(64),
      ["sha256=abc"],
    ])
      expect(verifySignature(b, s, profile.appSecret)).toBe(false);
    expect(verifyToken(profile.verifyToken, profile.verifyToken)).toBe(true);
    expect(verifyToken("wrong", profile.verifyToken)).toBe(false);
  });
  test("normalizes bounded text without media links or raw provider data", () => {
    const p = payload([
      message(),
      message({
        id: "media",
        type: "image",
        image: { url: "https://secret.example", id: "media-id" },
      }),
    ]);
    const events = normalizePayload(body(p), profile, 1793665000000);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "inbound",
      body: "Hello 😊",
      displayName: "Example",
    });
    expect(JSON.stringify(events)).not.toContain("secret.example");
    expect(events[1].body).toBe("");
  });
  test("rejects number/account spoofing, future timestamps, invalid identities and oversized batches atomically", () => {
    const wrongAccount = payload();
    wrongAccount.entry[0].id = "999999";
    const wrongNumber = payload();
    wrongNumber.entry[0].changes[0].value.metadata.phone_number_id = "999999";
    for (const p of [
      wrongAccount,
      wrongNumber,
      payload([message({ from: "fake" })]),
      payload([message({ timestamp: "99999999999" })]),
      payload(Array.from({ length: 101 }, () => message())),
    ])
      expect(() => normalizePayload(body(p), profile, 1793665000000)).toThrow();
  });
  test("recognizes Business App echoes and deduplicable delivery receipts", () => {
    const p = payload([]);
    p.entry[0].changes[0].field = "smb_message_echoes";
    p.entry[0].changes[0].value.message_echoes = [
      message({ to: "61412345678" }),
    ];
    expect(normalizePayload(body(p), profile, 1793665000000)[0].kind).toBe(
      "app_echo",
    );
    const status = payload([]);
    status.entry[0].changes[0].value.statuses = [
      {
        id: "wamid.sent",
        timestamp: "1793664000",
        status: "read",
        errors: [{ message: "sensitive" }],
      },
    ];
    expect(
      normalizePayload(body(status), profile, 1793665000000)[0],
    ).toMatchObject({ kind: "delivery", status: "read" });
    expect(
      JSON.stringify(normalizePayload(body(status), profile, 1793665000000)),
    ).not.toContain("sensitive");
  });
  test("retains an opaque voice media reference for the later transcription pipeline, never a download URL", () => {
    const audio = message({
      type: "audio",
      audio: {
        id: "123456789",
        mime_type: "audio/ogg",
        voice: true,
        url: "https://secret.example/voice",
      },
    });
    const e = normalizePayload(
      body(payload([audio])),
      profile,
      1793665000000,
    )[0];
    expect(e.media).toEqual({
      id: "123456789",
      mimeType: "audio/ogg",
      voice: true,
    });
    expect(e.body).toBe("");
    expect(JSON.stringify(e)).not.toContain("secret.example");
  });
  test("bounds retained text with an explicit truncation marker", () => {
    const event = normalizePayload(
      body(payload([message({ text: { body: "x".repeat(4096) } })])),
      profile,
      1793665000000,
    )[0];
    expect(event.body.length).toBe(4000);
    expect(event.truncated).toBe(true);
  });
  test("requires deployment-owned tenant/number bindings and secrets, rejects ambiguous bindings", () => {
    const p = {
      id: profile.id,
      label: "Test number",
      customerId: profile.customerId,
      phoneNumberId: profile.phoneNumberId,
      businessAccountId: profile.businessAccountId,
      appSecretEnv: "WHATSAPP_TEST_SECRET",
      verifyTokenEnv: "WHATSAPP_TEST_VERIFY",
    };
    expect(
      channelProfiles({ WHATSAPP_INBOUND_PROFILES: JSON.stringify([p]) })[0]
        .ready,
    ).toBe(false);
    expect(() =>
      channelProfiles({ WHATSAPP_INBOUND_PROFILES: JSON.stringify([p, p]) }),
    ).toThrow();
    expect(() =>
      channelProfiles({
        WHATSAPP_INBOUND_PROFILES: JSON.stringify([
          { ...p, customerId: "browser-tenant" },
        ]),
      }),
    ).toThrow();
  });
  test("serves the verification challenge, rejects bad signatures and acknowledges only committed receipts", async () => {
    const receive = jest.fn().mockResolvedValue({ inserted: 1 });
    const app = express()
      .use(
        "/api",
        createWhatsAppWebhookRouter({ profiles: () => [profile], receive }),
      )
      .use(express.json());
    await request(app)
      .get("/api/webhooks/whatsapp/test_number")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": profile.verifyToken,
        "hub.challenge": "12345",
      })
      .expect(200, "12345");
    await request(app)
      .get("/api/webhooks/whatsapp/test_number")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "12345",
      })
      .expect(403);
    const b = body(payload());
    await request(app)
      .post("/api/webhooks/whatsapp/test_number")
      .type("json")
      .send(b.toString())
      .expect(401);
    expect(receive).not.toHaveBeenCalled();
    await request(app)
      .post("/api/webhooks/whatsapp/test_number")
      .set("x-hub-signature-256", sign(b))
      .type("json")
      .send(b.toString())
      .expect(200);
    expect(receive).toHaveBeenCalledTimes(1);
    receive.mockRejectedValueOnce(new Error("database unavailable"));
    await request(app)
      .post("/api/webhooks/whatsapp/test_number")
      .set("x-hub-signature-256", sign(b))
      .type("json")
      .send(b.toString())
      .expect(503);
  });
  test("fails closed for unknown profiles, invalid signed JSON, oversized bodies and unavailable configuration", async () => {
    const receive = jest.fn();
    const app = express().use(
      createWhatsAppWebhookRouter({ profiles: () => [profile], receive }),
    );
    await request(app)
      .post("/webhooks/whatsapp/unknown")
      .type("json")
      .send("{}")
      .expect(404);
    const b = Buffer.from("{");
    await request(app)
      .post("/webhooks/whatsapp/test_number")
      .type("json")
      .set("x-hub-signature-256", sign(b))
      .send(b.toString())
      .expect(400);
    await request(app)
      .post("/webhooks/whatsapp/test_number")
      .type("json")
      .send("x".repeat(270000))
      .expect(413);
    expect(receive).not.toHaveBeenCalled();
  });
});
