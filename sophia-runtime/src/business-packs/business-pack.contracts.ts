import { z } from "zod";
import type { ConnectorCapabilityManifest } from "../capabilities-v2/connectors/connector-capability.manifest.js";
import type { CapabilityOperationId } from "../capabilities-v2/contracts/business-capability.contracts.js";
import type { RuntimeTool } from "../tools/tool-registry.js";
import type { OperationStatus } from "../capabilities-v2/contracts/business-capability.contracts.js";

export type WorkflowTemplateRegistration = {
  templateKey: string;
  version: string;
  displayName: string;
  description: string;
  ownerKey: string;
  connectorKey: string;
  configurationSchema: Record<string, unknown>;
  requiredAuthorization: readonly string[];
  statusOperationId: "workflow.status";
  retry: { support: "unsupported" } | {
    support: "owner-idempotent";
    execute(workflowRef: string, idempotencyKey: string): Promise<OperationStatus>;
  };
  parseConfiguration(value: unknown): Record<string, unknown>;
  getStatus(workflowRef: string): Promise<OperationStatus>;
};

export const AnalyticsMetricDefinitionSchema = z.object({
  metricKey: z.string().regex(/^[a-z][a-z0-9.-]{2,159}$/),
  version: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500),
  unit: z.literal("count"),
  evidenceClass: z.literal("source_confirmed"),
  denominatorMetricKey: z.string().regex(/^[a-z][a-z0-9.-]{2,159}$/).optional(),
  source: z.object({
    kind: z.literal("canonical_tool_outcome"),
    canonicalToolId: z.string().trim().min(1).max(160),
    outcomeClass: z.literal("success"),
  }).strict(),
}).strict();

export type AnalyticsMetricDefinition = z.infer<typeof AnalyticsMetricDefinitionSchema>;

export const BusinessPackManifestSchema = z.object({
  packId: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  toolCatalogVersion: z.string().trim().min(1).max(128),
  connectorKeys: z.array(z.string().trim().min(1).max(160)).min(1),
  capabilities: z.array(z.string().trim().min(1).max(160)).min(1),
  operations: z.array(z.string().trim().min(1).max(160)).min(1),
  schemaExtensionIds: z.array(z.string().trim().min(1).max(160)),
  uiRendererIds: z.array(z.string().trim().min(1).max(160)),
  legacyAliases: z.record(z.string(), z.string().trim().min(1).max(160)),
}).strict();

export type BusinessPackManifest = z.infer<typeof BusinessPackManifestSchema>;

export type BusinessPackRegistration = {
  manifest: BusinessPackManifest;
  connectorManifest: ConnectorCapabilityManifest;
  tools: RuntimeTool<any, unknown>[];
  instructionFragments: {
    canonical: readonly string[];
    legacy: readonly string[];
  };
  operationIds: readonly CapabilityOperationId[];
  connectorAdministration: {
    connectorKey: string;
    displayName: string;
    authMode: "runtime-scoped-token";
    accountBindingMode: "tenant-external-company" | "connector-verified";
    allowedScopes: readonly string[];
    credentialReference: string;
    verifyAccount(externalAccountId: string): Promise<{ externalAccountId: string }>;
  };
  workflowTemplates: readonly WorkflowTemplateRegistration[];
  analyticsMetrics: readonly AnalyticsMetricDefinition[];
};
