import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BillingSubscriptionCommitmentService } from "./billing-subscription-commitment.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const subscriptionId = "22222222-2222-4222-8222-222222222222";
const planVersionId = "33333333-3333-4333-8333-333333333333";

describe("BillingSubscriptionCommitmentService", () => {
  beforeEach(() => { process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example"; });
  afterEach(() => { jest.restoreAllMocks(); });

  it("activates the immutable twelve-period commitment only from a paid commencement invoice", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ billing_subscription_reference_id: subscriptionId,
        current_period_start: "2026-10-02T00:00:00.000Z", current_period_end: "2026-11-02T00:00:00.000Z",
        observed_at: "2026-10-02T00:00:01.000Z", commercial_plan_version_id: planVersionId }] } as never)
      .mockResolvedValueOnce({ rows: [{ commercial_assignment_id: "44444444-4444-4444-8444-444444444444",
        commercial_plan_version_id: planVersionId, minimum_commitment_months: 12, billing_interval: "month" }] } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);
    const service = new BillingSubscriptionCommitmentService({} as never);
    await expect(service.activateFromPaidInvoice({ query } as never, tenantId, "stripe-sophia", "sandbox",
      "legacy-primary", { externalRef: "in_initial", status: "paid", currency: "AUD",
        amountDueMinor: "114000", amountPaidMinor: "114000", hostedInvoiceUrl: null, dueAt: null,
        observedAt: "2026-10-02T00:00:02.000Z", externalSubscriptionRef: "sub_founding",
        billingReason: "subscription_create" })).resolves.toMatchObject({ status: "activated",
      requiredPeriods: 12, commencementPeriodStart: "2026-10-02T00:00:00.000Z" });
    expect(String(query.mock.calls[2][0])).toContain("billing_subscription_commitments");
    expect(query.mock.calls[2][1]).toEqual(expect.arrayContaining([12, "2026-10-02T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z"]));
  });

  it("refuses to activate a commitment when subscription metadata pins another plan", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ billing_subscription_reference_id: subscriptionId,
        current_period_start: "2026-10-02T00:00:00.000Z", current_period_end: "2026-11-02T00:00:00.000Z",
        observed_at: "2026-10-02T00:00:01.000Z",
        commercial_plan_version_id: "99999999-9999-4999-8999-999999999999" }] } as never)
      .mockResolvedValueOnce({ rows: [{ commercial_assignment_id: "44444444-4444-4444-8444-444444444444",
        commercial_plan_version_id: planVersionId, minimum_commitment_months: 12, billing_interval: "month" }] } as never);
    const service = new BillingSubscriptionCommitmentService({} as never);
    await expect(service.activateFromPaidInvoice({ query } as never, tenantId, "stripe-sophia", "sandbox",
      "legacy-primary", { externalRef: "in_initial", status: "paid", currency: "AUD",
        amountDueMinor: "114000", amountPaidMinor: "114000", hostedInvoiceUrl: null, dueAt: null,
        observedAt: "2026-10-02T00:00:02.000Z", externalSubscriptionRef: "sub_founding",
        billingReason: "subscription_create" })).rejects.toThrow(
      "Paid commencement subscription metadata does not match the active commercial plan.");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("establishes the exact commitment end only from twelve contiguous provider periods", async () => {
    const periods = Array.from({ length: 12 }, (_, index) => ({
      period_start: new Date(Date.UTC(2026, index + 0, 1)).toISOString(),
      period_end: new Date(Date.UTC(2026, index + 1, 1)).toISOString(),
    }));
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ billing_subscription_reference_id: subscriptionId }] } as never)
      .mockResolvedValueOnce({ rows: [{ billing_subscription_commitment_id: "55555555-5555-4555-8555-555555555555",
        required_periods: 12, periods_observed: 1, commencement_period_start: periods[0].period_start,
        commitment_end: null, last_observed_at: "2026-01-01T00:00:01.000Z" }] } as never)
      .mockResolvedValueOnce({ rows: [{ commercial_plan_version_id: planVersionId }] } as never)
      .mockResolvedValueOnce({ rows: [{ billing_subscription_commitment_id: "55555555-5555-4555-8555-555555555555",
        required_periods: 12, periods_observed: 1, commencement_period_start: periods[0].period_start,
        commitment_end: null, last_observed_at: "2026-01-01T00:00:01.000Z" }] } as never)
      .mockResolvedValueOnce({ rows: periods } as never)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);
    const service = new BillingSubscriptionCommitmentService({} as never);
    await expect(service.observe({ query } as never, tenantId, "stripe-sophia", "sandbox", "legacy-primary", {
      externalRef: "sub_founding", status: "active", currentPeriodStart: periods[11].period_start,
      currentPeriodEnd: periods[11].period_end, observedAt: "2026-12-01T00:00:01.000Z",
      planVersionId, billingAnchor: periods[0].period_start,
    })).resolves.toEqual({ status: "boundary_established", requiredPeriods: 12, periodsObserved: 12,
      commitmentEnd: periods[11].period_end });
    expect(query.mock.calls[5][1]).toEqual(expect.arrayContaining([12, periods[11].period_end]));
  });

  it("keeps cancellation restricted before the exact boundary and enables it afterwards", async () => {
    const query = jest.fn(async () => ({ rows: [{ minimum_commitment_months: 12, required_periods: 12,
      periods_observed: 12, commitment_end: "2027-10-02T00:00:00.000Z" }] }));
    const run = async (_tenant: string, work: (client: { query: typeof query }) => unknown) => work({ query });
    const service = new BillingSubscriptionCommitmentService({ tenantReadTransaction: run } as never);
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2027-10-01T23:59:59.000Z"));
    await expect(service.portalPolicy(tenantId, "stripe-sophia", "sandbox", "legacy-primary"))
      .resolves.toMatchObject({ mode: "commitment_restricted", commitmentEnd: "2027-10-02T00:00:00.000Z" });
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2027-10-02T00:00:00.000Z"));
    await expect(service.portalPolicy(tenantId, "stripe-sophia", "sandbox", "legacy-primary"))
      .resolves.toMatchObject({ mode: "standard", commitmentEnd: "2027-10-02T00:00:00.000Z" });
  });
});
