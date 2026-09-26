import type { CapabilityOperationId } from "../contracts/business-capability.contracts.js";

export type SharedCapabilityCatalogEntry = {
  operationId: CapabilityOperationId;
  port: "KnowledgePort" | "CatalogPort" | "AvailabilityPort" | "BookingPort" | "DeliveryPort" | "WorkflowStatusPort" | "HandoffPort" | "PresentationPort";
  sideEffectClass: "read" | "ephemeral-ui" | "prepare-command" | "business-mutation" | "notification" | "handoff";
  confirmationPolicy: "none" | "explicit-user-review";
};

export const SHARED_CAPABILITY_CATALOG: readonly SharedCapabilityCatalogEntry[] = [
  entry("knowledge.search", "KnowledgePort", "read"),
  entry("catalog.search", "CatalogPort", "read"),
  entry("catalog.get", "CatalogPort", "read"),
  entry("catalog.media", "CatalogPort", "read"),
  entry("availability.search", "AvailabilityPort", "read"),
  entry("availability.revalidate", "AvailabilityPort", "read"),
  entry("booking.prepare", "BookingPort", "prepare-command"),
  entry("booking.commit", "BookingPort", "business-mutation", "explicit-user-review"),
  entry("booking.status", "BookingPort", "read"),
  entry("booking.reconcile", "BookingPort", "read"),
  entry("delivery.status", "DeliveryPort", "read"),
  entry("delivery.prepare-resend", "DeliveryPort", "prepare-command"),
  entry("delivery.commit-resend", "DeliveryPort", "notification", "explicit-user-review"),
  entry("delivery.reconcile", "DeliveryPort", "read"),
  entry("workflow.status", "WorkflowStatusPort", "read"),
  entry("handoff.request", "HandoffPort", "handoff", "explicit-user-review"),
  entry("handoff.status", "HandoffPort", "read"),
  entry("ui.dismiss", "PresentationPort", "ephemeral-ui"),
];

function entry(
  operationId: CapabilityOperationId,
  port: SharedCapabilityCatalogEntry["port"],
  sideEffectClass: SharedCapabilityCatalogEntry["sideEffectClass"],
  confirmationPolicy: SharedCapabilityCatalogEntry["confirmationPolicy"] = "none",
): SharedCapabilityCatalogEntry {
  return { operationId, port, sideEffectClass, confirmationPolicy };
}
