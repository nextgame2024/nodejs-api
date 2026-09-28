export const BILLING_METER_EVENT_DISPATCHER = Symbol("BILLING_METER_EVENT_DISPATCHER");
export const BILLING_METER_EVENT_RECONCILER = Symbol("BILLING_METER_EVENT_RECONCILER");

export type BillingMeterEventInput = {
  submissionIdentifier: string;
  providerKey: string;
  providerEnvironment: "sandbox" | "live";
  providerAccountKey: string;
  externalCustomerRef: string;
  meterBindingKey: string;
  eventTimestamp: string;
  quantity: string;
  quantityUnit: "whole-minute";
  payloadDigest: string;
};

export type BillingMeterEventDispatchResult =
  | { outcome: "accepted"; providerEventRef: string; acceptedAt: string }
  | { outcome: "definite_failure"; retryable: boolean; code: string; detail: string }
  | { outcome: "unknown"; code: string; detail: string };

export interface BillingMeterEventDispatcher {
  status(): { availability: "disabled" | "configured"; detail: string };
  submit(input: BillingMeterEventInput): Promise<BillingMeterEventDispatchResult>;
}

export type BillingMeterEventReconciliationInput = {
  providerKey: string;
  providerEnvironment: "sandbox" | "live";
  providerAccountKey: string;
  planVersionId: string;
  externalCustomerRef: string;
  meterBindingKey: string;
  submissionIdentifier: string;
  periodStart: string;
  periodEnd: string;
  quantity: string;
  unitPriceMinor: string;
  currency: string;
};

export type BillingMeterEventReconciliationEvidence = {
  providerEventRef: string;
  meterRef: string;
  meterSummaryRef: string;
  meterSummaryStart: string;
  meterSummaryEnd: string;
  meterSummaryQuantity: string;
  invoiceRef: string;
  invoiceLineRef: string;
  meteredPriceRef: string;
  invoiceLineQuantity: string;
  invoiceLineAmountMinor: string;
  currency: string;
  observedAt: string;
};

export type BillingMeterEventReconciliationResult =
  | { outcome: "matched"; evidence: BillingMeterEventReconciliationEvidence }
  | { outcome: "pending"; detail: string }
  | { outcome: "mismatch"; detail: string };

export interface BillingMeterEventReconciler {
  reconcile(input: BillingMeterEventReconciliationInput): Promise<BillingMeterEventReconciliationResult>;
}
