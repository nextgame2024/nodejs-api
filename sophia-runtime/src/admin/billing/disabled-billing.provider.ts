import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { BillingProvider, BillingProviderStatus } from "./billing-provider.port.js";

@Injectable()
export class DisabledBillingProvider implements BillingProvider {
  status(): BillingProviderStatus {
    return { availability: "disabled", providerKey: null, checkout: false, portal: false, signedWebhooks: false,
      reconciliation: false, missingConfiguration: ["provider"],
      detail: "No Sophia billing provider, approved commercial plan or sandbox lifecycle is configured." };
  }
  mappedPlanVersionIds(): ReadonlySet<string> { return new Set(); }
  createHostedCheckout(): Promise<never> { return Promise.reject(unavailable()); }
  createHostedPortal(): Promise<never> { return Promise.reject(unavailable()); }
  verifyWebhook(): Promise<never> { return Promise.reject(unavailable()); }
  reconcileTenant(): Promise<never> { return Promise.reject(unavailable()); }
}

function unavailable() { return new ServiceUnavailableException("Sophia billing integration is disabled."); }
