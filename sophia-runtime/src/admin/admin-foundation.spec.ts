import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminAuditService } from "./authorization/admin-audit.service.js";
import { AdminModule } from "./admin.module.js";
import { StripeBillingProvider } from "./billing/stripe-billing.provider.js";
import { StripeBillingMeterEventDispatcher } from "./billing/stripe-billing-meter-event.dispatcher.js";
import { BILLING_INVOICE_ADJUSTMENT_DISPATCHER } from "./billing/billing-invoice-adjustment.port.js";
import { BILLING_COMMERCIAL_MILESTONE_DISPATCHER } from "./billing/billing-commercial-milestone.port.js";

describe("Sophia Admin foundation", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("references existing identities without duplicating credentials", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "../database/migrations/007_admin_authorization_foundation.sql"),
      "utf8",
    );
    expect(sql).toContain("identity_user_id text NOT NULL");
    expect(sql).toContain("UNIQUE (customer_id, identity_user_id)");
    expect(sql).not.toMatch(/CREATE TABLE[^;]*(?:users|identities)/i);
    expect(sql).not.toMatch(/(?:password|access_token|refresh_token|mfa_secret)\s+text/i);
  });

  it("redacts sensitive audit metadata before persistence", async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const audit = new AdminAuditService(database as never);
    await audit.record({
      eventType: "admin.test",
      outcome: "denied",
      metadata: {
        reason: "test",
        authorization: "Bearer secret",
        transcript: "private content",
        nested: { credential: "nested-secret", safe: "visible" },
      },
    });

    const params = database.query.mock.calls[0]?.[1] as unknown[];
    expect(params[8]).toBe(JSON.stringify({
      reason: "test",
      authorization: "[REDACTED]",
      transcript: "[REDACTED]",
      nested: { credential: "[REDACTED]", safe: "visible" },
    }));
  });

  it("constructs the Stripe adapter through an explicit configuration factory", () => {
    const providers = Reflect.getMetadata("providers", AdminModule) as unknown[];
    expect(providers).not.toContain(StripeBillingProvider);
    const registration = providers.find((provider) => provider && typeof provider === "object"
      && (provider as { provide?: unknown }).provide === StripeBillingProvider) as
      { useFactory?: () => StripeBillingProvider } | undefined;
    expect(registration?.useFactory).toEqual(expect.any(Function));
    expect(registration?.useFactory?.()).toBeInstanceOf(StripeBillingProvider);
  });

  it("constructs the Stripe Meter adapter through an explicit configuration factory", () => {
    const providers = Reflect.getMetadata("providers", AdminModule) as unknown[];
    expect(providers).not.toContain(StripeBillingMeterEventDispatcher);
    const registration = providers.find((provider) => provider && typeof provider === "object"
      && (provider as { provide?: unknown }).provide === StripeBillingMeterEventDispatcher) as
      { useFactory?: () => StripeBillingMeterEventDispatcher } | undefined;
    expect(registration?.useFactory).toEqual(expect.any(Function));
    expect(registration?.useFactory?.()).toBeInstanceOf(StripeBillingMeterEventDispatcher);
  });

  it("keeps live collection adapters wired while their independent switches remain default-off", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_live";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "sk_live_sophia";
    delete process.env.SOPHIA_BILLING_LIVE_OVERAGE_ENABLED;
    delete process.env.SOPHIA_BILLING_LIVE_MILESTONE_ENABLED;
    const providers = Reflect.getMetadata("providers", AdminModule) as unknown[];
    for (const token of [BILLING_INVOICE_ADJUSTMENT_DISPATCHER, BILLING_COMMERCIAL_MILESTONE_DISPATCHER]) {
      const registration = providers.find((provider) => provider && typeof provider === "object"
        && (provider as { provide?: unknown }).provide === token) as
        { useFactory?: (disabled: object, stripe: object) => object } | undefined;
      const disabled = {}; const stripe = {};
      expect(registration?.useFactory?.(disabled, stripe)).toBe(stripe);
    }
    delete process.env.SOPHIA_BILLING_PROVIDER;
    delete process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY;
  });
});
