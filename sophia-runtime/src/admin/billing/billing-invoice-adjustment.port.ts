export const BILLING_INVOICE_ADJUSTMENT_DISPATCHER = Symbol("BILLING_INVOICE_ADJUSTMENT_DISPATCHER");

export type BillingInvoiceAdjustmentInput = {
  adjustmentId: string;
  deliveryId: string;
  ledgerId: string;
  planVersionId: string;
  providerKey: string;
  providerEnvironment: "sandbox" | "live";
  providerAccountKey: string;
  externalCustomerRef: string;
  externalSubscriptionRef: string;
  externalInvoiceRef: string;
  oneTimePriceRef: string;
  periodStart: string;
  periodEnd: string;
  targetPeriodStart: string;
  targetPeriodEnd: string;
  quantity: string;
  unitPriceMinor: string;
  currency: string;
  payloadDigest: string;
};

export type BillingInvoiceAdjustmentDispatchResult =
  | { outcome: "accepted"; providerInvoiceItemRef: string; acceptedAt: string }
  | { outcome: "definite_failure"; retryable: boolean; code: string; detail: string }
  | { outcome: "unknown"; code: string; detail: string };

export type BillingInvoiceAdjustmentReconciliationResult =
  | { outcome: "matched"; evidence: { providerInvoiceItemRef: string; providerInvoiceLineRef: string;
      oneTimePriceRef: string; periodStart: string; periodEnd: string; quantity: string;
      unitPriceMinor: string; amountMinor: string; currency: string; invoiceStatus: string; observedAt: string } }
  | { outcome: "pending" | "mismatch"; detail: string };

export interface BillingInvoiceAdjustmentDispatcher {
  status(): { availability: "disabled" | "configured"; detail: string };
  submit(input: BillingInvoiceAdjustmentInput): Promise<BillingInvoiceAdjustmentDispatchResult>;
  reconcile(input: BillingInvoiceAdjustmentInput): Promise<BillingInvoiceAdjustmentReconciliationResult>;
}
