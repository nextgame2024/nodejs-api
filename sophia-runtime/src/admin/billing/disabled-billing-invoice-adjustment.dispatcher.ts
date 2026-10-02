import { Injectable } from "@nestjs/common";
import type {
  BillingInvoiceAdjustmentDispatcher,
  BillingInvoiceAdjustmentInput,
} from "./billing-invoice-adjustment.port.js";

@Injectable()
export class DisabledBillingInvoiceAdjustmentDispatcher implements BillingInvoiceAdjustmentDispatcher {
  status() {
    return { availability: "disabled" as const, detail: "Billing invoice adjustments are disabled." };
  }

  submit(_input: BillingInvoiceAdjustmentInput) {
    return Promise.resolve({ outcome: "definite_failure" as const, retryable: false,
      code: "invoice_adjustment_disabled", detail: "Billing invoice adjustments are disabled." });
  }

  reconcile(_input: BillingInvoiceAdjustmentInput) {
    return Promise.resolve({ outcome: "pending" as const, detail: "Billing invoice adjustments are disabled." });
  }
}
