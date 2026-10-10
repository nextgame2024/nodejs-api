import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { createHmac } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { XeroWebhookController } from "./xero-webhook.controller.js";

const original = { ...process.env };

beforeAll(() => {
  process.env.XERO_CLIENT_ID = "client";
  process.env.XERO_CLIENT_SECRET = "secret";
  process.env.XERO_REDIRECT_URI = "https://runtime.example/callback";
  process.env.XERO_RETURN_URL = "https://app.example/company";
  process.env.XERO_OAUTH_STATE_SECRET = "state-secret-with-at-least-thirty-two-characters";
  process.env.XERO_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  process.env.XERO_WEBHOOK_KEY = "webhook-key";
});

afterAll(() => { process.env = original; });

describe("XeroWebhookController", () => {
  it("verifies the raw payload and coalesces relevant events by Xero tenant", async () => {
    const enqueueWebhook = jest.fn().mockResolvedValue(true);
    const controller = new XeroWebhookController({ enqueueWebhook } as never);
    const body = {
      events: [
        { tenantId: "11111111-1111-4111-8111-111111111111", eventCategory: "INVOICE" },
        { tenantId: "11111111-1111-4111-8111-111111111111", eventCategory: "CONTACT" },
        { tenantId: "22222222-2222-4222-8222-222222222222", eventCategory: "SUBSCRIPTION" },
      ],
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = createHmac("sha256", "webhook-key").update(rawBody).digest("base64");

    await expect(controller.receive({ rawBody }, signature, body)).resolves.toEqual({});
    expect(enqueueWebhook).toHaveBeenCalledTimes(1);
    expect(enqueueWebhook).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("rejects an invalid signature before enqueueing work", async () => {
    const enqueueWebhook = jest.fn();
    const controller = new XeroWebhookController({ enqueueWebhook } as never);
    await expect(controller.receive(
      { rawBody: Buffer.from("{}") },
      Buffer.alloc(32).toString("base64"),
      { events: [] },
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueueWebhook).not.toHaveBeenCalled();
  });
});
