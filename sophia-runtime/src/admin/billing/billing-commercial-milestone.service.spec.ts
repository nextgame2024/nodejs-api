import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BillingCommercialMilestoneService } from "./billing-commercial-milestone.service.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const planVersionId = "22222222-2222-4222-8222-222222222222";
const componentId = "33333333-3333-4333-8333-333333333333";
const acceptanceId = "44444444-4444-4444-8444-444444444444";
const outboxId = "55555555-5555-4555-8555-555555555555";
const original = new Map<string, string | undefined>();

describe("BillingCommercialMilestoneService", () => {
  beforeEach(() => {
    for (const key of ["SOPHIA_RUNTIME_DATABASE_URL", "SOPHIA_BILLING_PROVIDER",
      "SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY", "SOPHIA_BILLING_STRIPE_SECRET_KEY",
      "SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS", "SOPHIA_BILLING_LIVE_MILESTONE_ENABLED"] as const) {
      original.set(key, process.env[key]); delete process.env[key];
    }
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY = "legacy-primary";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "sk_test_sophia";
    process.env.SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS =
      `{"${planVersionId}":{"production-deployment":"price_foundingDeployment123"}}`;
  });
  afterEach(() => {
    for (const [key, value] of original) value === undefined ? delete process.env[key] : process.env[key] = value;
    original.clear();
  });

  it("persists one immutable acceptance and dispatches its exact digest-bound sandbox invoice", async () => {
    const payload = { acceptanceId, planVersionId, componentKey: "production-deployment",
      milestoneKey: "production-deployment", providerKey: "stripe-sophia", providerEnvironment: "sandbox",
      providerAccountKey: "legacy-primary", externalCustomerRef: "cus_sophia_1",
      oneTimePriceRef: "price_foundingDeployment123", quantity: "1", unitPriceMinor: "95000", currency: "AUD" };
    const row = { billing_commercial_milestone_outbox_id: outboxId,
      billing_commercial_milestone_acceptance_id: acceptanceId, commercial_plan_version_id: planVersionId,
      component_key: "production-deployment", milestone_key: "production-deployment", provider_key: "stripe-sophia",
      provider_environment: "sandbox", provider_account_key: "legacy-primary",
      external_customer_ref: "cus_sophia_1", one_time_price_ref: "price_foundingDeployment123",
      quantity: "1", unit_price_minor: "95000", currency: "AUD",
      payload_digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), status: "pending",
      external_invoice_ref: null, provider_invoice_item_ref: null };
    const query = jest.fn();
    query
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ commercial_plan_version_id: planVersionId,
        commercial_plan_charge_component_id: componentId, amount_minor: "95000", currency: "AUD",
        external_customer_ref: "cus_sophia_1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ billing_commercial_milestone_acceptance_id: acceptanceId }] } as never)
      .mockResolvedValueOnce({ rows: [row] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ billing_commercial_milestone_outbox_id: outboxId }] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ ...row, status: "provider_accepted", external_invoice_ref: "in_milestone_1",
        provider_invoice_item_ref: "ii_milestone_1" }] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);
    const run = async (_tenant: string, callback: (client: { query: typeof query }) => unknown) => callback({ query });
    const dispatcher = { status: jest.fn(() => ({ availability: "configured" as const, detail: "configured" })),
      submit: jest.fn(async () => ({ outcome: "accepted" as const, externalInvoiceRef: "in_milestone_1",
        providerInvoiceItemRef: "ii_milestone_1", acceptedAt: "2026-10-02T12:00:00.000Z" })),
      reconcile: jest.fn(async () => ({ outcome: "matched" as const, evidence: {
        externalInvoiceRef: "in_milestone_1", providerInvoiceItemRef: "ii_milestone_1",
        providerInvoiceLineRef: "il_milestone_1", oneTimePriceRef: "price_foundingDeployment123",
        quantity: "1" as const, unitPriceMinor: "95000", amountMinor: "95000", currency: "AUD",
        invoiceStatus: "paid", observedAt: "2026-10-02T12:00:01.000Z",
      } })) };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new BillingCommercialMilestoneService({ tenantTransaction: run, tenantReadTransaction: run } as never,
      dispatcher as never, audit as never);
    await expect(service.acceptProductionDeployment(tenantId, principal(), {
      requestId: "66666666-6666-4666-8666-666666666666", evidenceRef: "render-deploy:53c5ed7",
    })).resolves.toMatchObject({ stage: "milestone_invoice_reconciled", acceptanceId, milestoneOutboxId: outboxId,
      existing: false, liveCharge: false, dispatch: { status: "provider_accepted",
        externalInvoiceRef: "in_milestone_1", providerInvoiceItemRef: "ii_milestone_1" },
      reconciliation: { status: "reconciled", milestoneOutboxId: outboxId } });
    expect(dispatcher.submit).toHaveBeenCalledWith(expect.objectContaining({ milestoneOutboxId: outboxId,
      acceptanceId, unitPriceMinor: "95000", currency: "AUD", payloadDigest: row.payload_digest }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "billing.commercial_milestone.accepted", permission: "billing.manage",
      metadata: expect.objectContaining({ evidenceRef: "render-deploy:53c5ed7", liveCharge: false }),
    }), expect.anything());
  });

  it("keeps live milestone acceptance disabled until its independent switch is enabled", async () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_live";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "sk_live_sophia";
    const transaction = jest.fn();
    const dispatcher = { status: jest.fn(() => ({ availability: "disabled" as const,
      detail: "Live commercial milestone invoicing is implemented but disabled." })), submit: jest.fn(),
      reconcile: jest.fn() };
    const service = new BillingCommercialMilestoneService({ tenantTransaction: transaction } as never,
      dispatcher as never, { record: jest.fn() } as never);
    await expect(service.acceptProductionDeployment(tenantId, principal(), {
      requestId: "66666666-6666-4666-8666-666666666666", evidenceRef: "render-deploy:pending",
    })).rejects.toThrow("implemented but disabled");
    expect(transaction).not.toHaveBeenCalled();
    expect(dispatcher.submit).not.toHaveBeenCalled();
  });
});

function principal(): AdminPrincipal {
  return { apiVersion: "1.0.0", identityUserId: "operator-1", tenantId,
    externalCompanyId: "77777777-7777-4777-8777-777777777777",
    membershipId: "88888888-8888-4888-8888-888888888888", role: "billing_administrator",
    permissions: ["billing.manage"], authorizationRevision: 1, mfaVerifiedAt: "2026-10-02T11:55:00.000Z" };
}
