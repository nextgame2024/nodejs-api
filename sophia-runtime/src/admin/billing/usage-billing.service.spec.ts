import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DisabledBillingProvider } from "./disabled-billing.provider.js";
import { UsageBillingService } from "./usage-billing.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

describe("UsageBillingService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("delegates operational usage without relabelling provider estimates as charges", async () => {
    const usage = jest.fn(async () => ({ providerCosts: [{ customerCharge: false }] }));
    const workspace = service(jest.fn(), usage);
    await expect(workspace.usage(tenantId)).resolves.toEqual({ providerCosts: [{ customerCharge: false }] });
    expect(usage).toHaveBeenCalledWith(tenantId);
  });

  it("returns an explicitly unavailable commercial state when no platform assignment exists", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("tenant_commercial_assignments")) return { rows: [] };
      if (sql.includes("billing_usage_period_ledgers")) return { rows: [] };
      if (sql.includes("billing_subscription_references") || sql.includes("billing_invoice_references")) return { rows: [] };
      if (sql.includes("billing_provider_customers") || sql.includes("billing_webhook_events")) return { rows: [] };
      if (sql.includes("billing_checkout_intents")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await service(query).commercial(tenantId);

    expect(result).toMatchObject({
      tenantId,
      providerIntegration: { availability: "disabled", checkout: false, portal: false, signedWebhooks: false,
        reconciliation: false, missingConfiguration: ["provider"] },
      assignment: null,
      preview: { status: "unavailable", chargeExecution: false },
      authority: { tenantPlanMutation: "unavailable" },
      isolation: { existingPayments: "excluded" },
    });
    expect(query.mock.calls.some((call) => String(call[0]).includes("provider_usage_events"))).toBe(false);
  });

  it("calculates an exact no-charge preview and exposes only provider reference records", async () => {
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("tenant_commercial_assignments")) return { rows: [{
        commercial_assignment_id: "assignment-1", assignment_status: "active",
        effective_from: "2020-01-01T00:00:00.000Z", effective_to: null,
        commercial_plan_version_id: "plan-1", plan_key: "growth", version: 1, display_name: "Growth",
        plan_status: "published", pricing_status: "configured", billing_currency: "AUD", billing_interval: "month",
        base_charge_minor: "100", tax_mode: "exclusive", tax_rate_basis_points: 1000,
        overage_rounding: "ceil", rate_card: { dimensions: [{
          dimension: "reasoning-input-tokens", includedQuantity: "10", unitQuantity: "1", unitPriceMinor: "3",
        }] }, entitlements: { concurrentSessions: 2 }, manifest_digest: "a".repeat(64),
      }] };
      if (sql.includes("provider_usage_events")) {
        expect(params?.[0]).toBe(tenantId);
        expect(params?.[1]).toBeInstanceOf(Date);
        expect(params?.[2]).toBeInstanceOf(Date);
        return { rows: [
          { dimension: "reasoning-input-tokens", measurement_status: "measured", quantity: "10.25" },
          { dimension: "reasoning-input-tokens", measurement_status: "measured", quantity: "0.25" },
        ] };
      }
      if (sql.includes("billing_usage_period_ledgers")) return { rows: [] };
      if (sql.includes("billing_subscription_references")) return { rows: [{ external_subscription_ref: "opaque-sub-ref" }] };
      if (sql.includes("billing_invoice_references")) return { rows: [{ external_invoice_ref: "opaque-invoice-ref" }] };
      if (sql.includes("billing_provider_customers")) return { rows: [] };
      if (sql.includes("billing_webhook_events")) return { rows: [] };
      if (sql.includes("billing_checkout_intents")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await service(query).commercial(tenantId);

    expect(result.preview).toMatchObject({
      status: "preview_only", chargeExecution: false, currency: "AUD", interval: "month",
      period: { boundary: "calendar_utc" }, evidenceStatus: "measured", baseChargeMinor: "100",
      subtotalMinor: "103", taxMinor: "11", totalMinor: "114",
      lineItems: [{ dimension: "reasoning-input-tokens", quantity: "10.5", overageQuantity: "0.5",
        billableOverageQuantity: "1", billingUnitQuantity: "1", amountMinor: "3" }],
    });
    expect(result.subscriptions).toEqual([{ external_subscription_ref: "opaque-sub-ref" }]);
    expect(result.invoices).toEqual([{ external_invoice_ref: "opaque-invoice-ref" }]);
    expect(JSON.stringify(result)).not.toMatch(/checkoutSession|paymentIntent|cardLastFour/i);
  });

  it("aggregates active seconds across the period before applying included usage and rounding once", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("tenant_commercial_assignments")) return { rows: [{
        commercial_assignment_id: "assignment-1", assignment_status: "active",
        effective_from: "2020-01-01T00:00:00.000Z", effective_to: null,
        commercial_plan_version_id: "plan-1", plan_key: "sophia-live", version: 1, display_name: "Sophia Live",
        plan_status: "published", pricing_status: "configured", billing_currency: "AUD", billing_interval: "month",
        base_charge_minor: "175000", tax_mode: "not_applicable", tax_rate_basis_points: null,
        overage_rounding: "ceil", rate_card: { dimensions: [{
          dimension: "active-seconds", includedQuantity: "120000", unitQuantity: "60", unitPriceMinor: "50",
        }] }, entitlements: { includedActiveMinutes: 2000 }, manifest_digest: "b".repeat(64),
      }] };
      if (sql.includes("provider_usage_events")) {
        expect(sql).toContain("d.key <> 'active-seconds'");
        expect(sql).toContain("session_activity_intervals");
        expect(sql).toContain("LEAST(COALESCE(ended_at,last_confirmed_at)");
        return { rows: [
        { dimension: "active-seconds", measurement_status: "measured", quantity: "119999" },
        { dimension: "active-seconds", measurement_status: "measured", quantity: "62" },
        ] };
      }
      if (sql.includes("billing_usage_period_ledgers")) return { rows: [] };
      if (sql.includes("billing_subscription_references") || sql.includes("billing_invoice_references")
        || sql.includes("billing_provider_customers") || sql.includes("billing_webhook_events")
        || sql.includes("billing_checkout_intents")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service(query).commercial(tenantId);

    expect(result.preview).toMatchObject({
      subtotalMinor: "175100", taxMinor: "0", totalMinor: "175100",
      lineItems: [{ dimension: "active-seconds", quantity: "120061", includedQuantity: "120000",
        overageQuantity: "61", billingUnitQuantity: "60", billableOverageQuantity: "2", amountMinor: "100" }],
    });
  });

  it("does not calculate GST when the effective seller policy is not GST registered", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("tenant_commercial_assignments")) return { rows: [{
        commercial_assignment_id: "assignment-1", assignment_status: "active",
        effective_from: "2020-01-01T00:00:00.000Z", effective_to: null,
        commercial_plan_version_id: "plan-1", plan_key: "sophia-voice", version: 1, display_name: "Sophia Voice",
        plan_status: "published", pricing_status: "configured", billing_currency: "AUD", billing_interval: "month",
        base_charge_minor: "75000", tax_mode: "exclusive", tax_rate_basis_points: 1000,
        overage_rounding: "ceil", rate_card: { dimensions: [] }, entitlements: {}, manifest_digest: "c".repeat(64),
        seller_legal_entity_id: "seller-1", tax_category: "standard_rate",
        seller_commercial_policy_version_id: "policy-1", seller_legal_entity_version_id: "legal-1",
        customer_scope: "business_only", gst_registered: false, tax_calculation_mode: "none",
        policy_tax_rate_basis_points: null, price_display_mode: "no_tax", tax_label: null,
      }] };
      if (sql.includes("billing_usage_period_ledgers")) return { rows: [] };
      if (sql.includes("provider_usage_events") || sql.includes("billing_subscription_references")
        || sql.includes("billing_invoice_references") || sql.includes("billing_provider_customers")
        || sql.includes("billing_webhook_events") || sql.includes("billing_checkout_intents")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service(query).commercial(tenantId);

    expect(result.assignment).toMatchObject({ taxMode: "not_applicable", taxCategory: "standard_rate",
      commercialPolicy: { customerScope: "business_only", gstRegistered: false,
        taxCalculationMode: "none", priceDisplayMode: "no_tax", taxLabel: null } });
    expect(result.preview).toMatchObject({ subtotalMinor: "75000", taxMinor: "0", totalMinor: "75000",
      taxMode: "not_applicable" });
  });

  it("keeps every provider mutation disabled", async () => {
    const provider = new DisabledBillingProvider();
    await expect(provider.createHostedCheckout({ tenantId, planVersionId: "plan-1", requestId: "request-1", customerRef: null,
      commercial: { currency: "AUD", interval: "month", baseChargeMinor: "100" } })).rejects.toThrow("billing integration is disabled");
    await expect(provider.createHostedPortal({ tenantId, requestId: "request-1", customerRef: "customer-1" })).rejects.toThrow("billing integration is disabled");
    await expect(provider.verifyWebhook({}, new Uint8Array())).rejects.toThrow("billing integration is disabled");
    await expect(provider.reconcileTenant({ tenantId, customerRef: "customer-1" })).rejects.toThrow("billing integration is disabled");
  });
});

function service(query: jest.Mock, usage = jest.fn(async () => ({}))) {
  const run = jest.fn(async (_tenantId: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return new UsageBillingService({ tenantReadTransaction: run } as never, { usage } as never, new DisabledBillingProvider());
}
