import { Injectable } from "@nestjs/common";
import type { BillingCommercialMilestoneDispatcher, BillingCommercialMilestoneInput } from "./billing-commercial-milestone.port.js";

@Injectable()
export class DisabledBillingCommercialMilestoneDispatcher implements BillingCommercialMilestoneDispatcher {
  status() { return { availability: "disabled" as const, detail: "Commercial milestone invoicing is disabled." }; }
  submit(_input: BillingCommercialMilestoneInput) {
    return Promise.resolve({ outcome: "definite_failure" as const, retryable: false,
      code: "commercial_milestone_disabled", detail: "Commercial milestone invoicing is disabled." });
  }
  reconcile(_input: BillingCommercialMilestoneInput & { externalInvoiceRef: string; providerInvoiceItemRef: string }) {
    return Promise.resolve({ outcome: "pending" as const, detail: "Commercial milestone invoicing is disabled." });
  }
}
