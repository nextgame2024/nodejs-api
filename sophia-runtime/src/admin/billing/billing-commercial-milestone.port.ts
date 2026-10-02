export const BILLING_COMMERCIAL_MILESTONE_DISPATCHER = Symbol("BILLING_COMMERCIAL_MILESTONE_DISPATCHER");

export type BillingCommercialMilestoneInput = {
  milestoneOutboxId: string;
  acceptanceId: string;
  planVersionId: string;
  componentKey: string;
  milestoneKey: string;
  providerKey: string;
  providerEnvironment: "sandbox" | "live";
  providerAccountKey: string;
  externalCustomerRef: string;
  oneTimePriceRef: string;
  quantity: "1";
  unitPriceMinor: string;
  currency: string;
  payloadDigest: string;
};

export type BillingCommercialMilestoneDispatchResult =
  | { outcome: "accepted"; externalInvoiceRef: string; providerInvoiceItemRef: string; acceptedAt: string }
  | { outcome: "definite_failure"; retryable: boolean; code: string; detail: string }
  | { outcome: "unknown"; code: string; detail: string };

export type BillingCommercialMilestoneReconciliationResult =
  | { outcome: "matched"; evidence: { externalInvoiceRef: string; providerInvoiceItemRef: string;
      providerInvoiceLineRef: string; oneTimePriceRef: string; quantity: "1"; unitPriceMinor: string;
      amountMinor: string; currency: string; invoiceStatus: string; observedAt: string } }
  | { outcome: "pending" | "mismatch"; detail: string };

export interface BillingCommercialMilestoneDispatcher {
  status(): { availability: "disabled" | "configured"; detail: string };
  submit(input: BillingCommercialMilestoneInput): Promise<BillingCommercialMilestoneDispatchResult>;
  reconcile(input: BillingCommercialMilestoneInput & { externalInvoiceRef: string; providerInvoiceItemRef: string }):
    Promise<BillingCommercialMilestoneReconciliationResult>;
}
