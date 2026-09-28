import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type {
  BillingMeterEventDispatcher,
  BillingMeterEventReconciler,
  BillingMeterEventReconciliationInput,
  BillingMeterEventReconciliationResult,
} from "./billing-meter-event.port.js";

@Injectable()
export class DisabledBillingMeterEventDispatcher implements BillingMeterEventDispatcher, BillingMeterEventReconciler {
  status() {
    return { availability: "disabled" as const,
      detail: "No approved provider Meter binding is configured; meter-event dispatch is disabled." };
  }

  submit(): Promise<never> {
    return Promise.reject(new ServiceUnavailableException(
      "Meter-event dispatch requires an approved provider adapter and Meter binding.",
    ));
  }

  reconcile(_input: BillingMeterEventReconciliationInput): Promise<BillingMeterEventReconciliationResult> {
    return Promise.resolve({ outcome: "pending", detail: "Billing Meter reconciliation is disabled." });
  }
}
