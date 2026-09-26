export const BILLING_PROVIDER = Symbol("BILLING_PROVIDER");

export type BillingProviderStatus = {
  availability: "disabled" | "sandbox" | "live";
  providerKey: string | null;
  checkout: boolean;
  portal: boolean;
  signedWebhooks: boolean;
  reconciliation: boolean;
  missingConfiguration: string[];
  detail: string;
};

export type BillingWebhookEvidence = {
  providerKey: string;
  environment: "sandbox" | "live";
  eventId: string;
  eventType: string;
  occurredAt: string;
  payloadDigest: string;
  customerRef: string | null;
  checkoutRef: string | null;
  tenantHint: string | null;
  planVersionHint: string | null;
  subscription: BillingSubscriptionObservation | null;
  invoice: BillingInvoiceObservation | null;
};

export type BillingSubscriptionObservation = {
  externalRef: string;
  status: "pending" | "trialing" | "active" | "past_due" | "paused" | "cancelled" | "unknown";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  observedAt: string;
};

export type BillingInvoiceObservation = {
  externalRef: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | "unknown";
  currency: string | null;
  amountDueMinor: string | null;
  amountPaidMinor: string | null;
  hostedInvoiceUrl: string | null;
  dueAt: string | null;
  observedAt: string;
};

export type BillingReconciliation = {
  status: "reconciled" | "incomplete";
  observedAt: string;
  subscriptions: BillingSubscriptionObservation[];
  invoices: BillingInvoiceObservation[];
};

export interface BillingProvider {
  status(): BillingProviderStatus;
  mappedPlanVersionIds(): ReadonlySet<string>;
  createHostedCheckout(input: { tenantId: string; planVersionId: string; requestId: string; customerRef: string | null;
    commercial: { currency: string; interval: "month" | "year"; baseChargeMinor: string } }): Promise<{
      url: string; expiresAt: string | null; externalCheckoutRef: string;
    }>;
  createHostedPortal(input: { tenantId: string; requestId: string; customerRef: string }): Promise<{ url: string; expiresAt: string | null }>;
  verifyWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array): Promise<BillingWebhookEvidence>;
  reconcileTenant(input: { tenantId: string; customerRef: string }): Promise<BillingReconciliation>;
}
