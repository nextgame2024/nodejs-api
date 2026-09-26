import { z } from "zod";
import { CapabilityOperationIdSchema, type CapabilityOperationId } from "../contracts/business-capability.contracts.js";

const mutationOperations = new Set<CapabilityOperationId>([
  "booking.commit", "delivery.commit-resend", "handoff.request",
]);
const reconciliationOperations = new Set<CapabilityOperationId>([
  "booking.reconcile", "delivery.reconcile",
]);
const liveStatusOperations = new Set<CapabilityOperationId>([
  "booking.status", "delivery.status", "workflow.status", "handoff.status",
]);

export const ConnectorOperationSupportSchema = z.object({
  operationId: CapabilityOperationIdSchema,
  enabled: z.boolean(),
  idempotency: z.enum(["not-applicable", "none", "stable-command"]),
  reconciliation: z.enum(["unsupported", "lookup", "repair"]),
  cancellation: z.enum(["unsupported", "before-commit", "supported"]),
  liveStatus: z.enum(["none", "poll", "push"]),
}).strict();

export const ConnectorCapabilityManifestSchema = z.object({
  connectorKey: z.string().trim().min(1).max(160),
  version: z.string().trim().min(1).max(80),
  operations: z.array(ConnectorOperationSupportSchema).min(1),
}).strict().superRefine((manifest, context) => {
  const operationIds = manifest.operations.map(({ operationId }) => operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    context.addIssue({ code: "custom", path: ["operations"], message: "Connector operation declarations must be unique." });
  }
});

export type ConnectorCapabilityManifest = z.infer<typeof ConnectorCapabilityManifestSchema>;

export function enabledConnectorOperations(input: unknown, requested: readonly CapabilityOperationId[]): CapabilityOperationId[] {
  const manifest = ConnectorCapabilityManifestSchema.parse(input);
  const support = new Map(manifest.operations.map((entry) => [entry.operationId, entry]));
  return requested.map((operationId) => {
    const entry = support.get(CapabilityOperationIdSchema.parse(operationId));
    if (!entry?.enabled) throw new Error(`Connector ${manifest.connectorKey} does not enable ${operationId}.`);
    if (mutationOperations.has(operationId) &&
      (entry.idempotency !== "stable-command" || entry.reconciliation === "unsupported")) {
      throw new Error(`Connector ${manifest.connectorKey} cannot safely expose mutation ${operationId}.`);
    }
    if (reconciliationOperations.has(operationId) && entry.reconciliation === "unsupported") {
      throw new Error(`Connector ${manifest.connectorKey} does not support reconciliation for ${operationId}.`);
    }
    if (liveStatusOperations.has(operationId) && entry.liveStatus === "none") {
      throw new Error(`Connector ${manifest.connectorKey} does not support live status for ${operationId}.`);
    }
    return operationId;
  });
}
