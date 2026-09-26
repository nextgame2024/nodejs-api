import type { ActionReviewStore } from "../../tools/action-review.store.js";
import type { BusinessPackRegistration } from "../business-pack.contracts.js";
import { BUSINESS_MANAGER_REAL_ESTATE_MANIFEST, type BusinessManagerRealEstateConnector } from "./business-manager-real-estate.connector.js";
import type { BusinessManagerClient } from "./business-manager.client.js";
import { createLegacyRealEstateToolAdapter } from "../../compatibility/v1/real-estate-tools.adapter.js";
import { REAL_ESTATE_CANONICAL_INSTRUCTIONS, REAL_ESTATE_LEGACY_INSTRUCTIONS } from "./real-estate.instructions.js";
import { CapabilityOperationIdSchema } from "../../capabilities-v2/contracts/business-capability.contracts.js";
import { z } from "zod";

const propertyReportWorkflowConfiguration = z.object({
  trigger: z.literal("sale-booking-committed"),
  reportFormat: z.literal("pdf"),
  delivery: z.literal("booking-confirmation-email"),
  requiredAuthorization: z.literal("booking-explicit-user-review"),
  retryOwnership: z.literal("business-manager"),
}).strict();

export function createRealEstateBusinessPack(
  client: BusinessManagerClient,
  reviews: ActionReviewStore,
  _connector: BusinessManagerRealEstateConnector,
): BusinessPackRegistration {
  const tools = createLegacyRealEstateToolAdapter(client, reviews);
  const operationIds = [...new Set([
    ...BUSINESS_MANAGER_REAL_ESTATE_MANIFEST.operations.filter(({ enabled }) => enabled).map(({ operationId }) => operationId),
    CapabilityOperationIdSchema.parse("ui.dismiss"),
  ])];
  return {
    manifest: {
      packId: "real-estate",
      version: "1.0.0",
      toolCatalogVersion: "current-real-estate-tools",
      connectorKeys: [BUSINESS_MANAGER_REAL_ESTATE_MANIFEST.connectorKey],
      capabilities: ["knowledge", "catalog", "availability", "booking", "delivery", "workflow-status", "presentation"],
      operations: operationIds,
      schemaExtensionIds: [
        "real-estate.catalog-search-extension", "real-estate.catalog-detail-extension",
        "real-estate.catalog-media-extension", "real-estate.availability-extension",
      ],
      uiRendererIds: [
        "real-estate.property-list", "real-estate.property-detail", "real-estate.media-gallery",
        "real-estate.inspection-availability", "real-estate.booking-review", "real-estate.operation-status",
      ],
      legacyAliases: Object.fromEntries(tools.map((tool) => [tool.definition.name, tool.policy!.toolId])),
    },
    connectorManifest: BUSINESS_MANAGER_REAL_ESTATE_MANIFEST,
    tools,
    instructionFragments: { canonical: REAL_ESTATE_CANONICAL_INSTRUCTIONS, legacy: REAL_ESTATE_LEGACY_INSTRUCTIONS },
    operationIds,
    connectorAdministration: {
      connectorKey: BUSINESS_MANAGER_REAL_ESTATE_MANIFEST.connectorKey,
      displayName: "Business Manager real estate",
      authMode: "runtime-scoped-token",
      accountBindingMode: "tenant-external-company",
      allowedScopes: [
        "bm:real-estate:read",
        "bm:real-estate:booking:write",
        "bm:real-estate:delivery:write",
      ],
      credentialReference: "runtime://scoped-connector/business-manager-real-estate",
      verifyAccount: (externalAccountId) => client.verifyConnectorIdentity(externalAccountId),
    },
    workflowTemplates: [{
      templateKey: "real-estate.sale-property-report",
      version: "1.0.0",
      displayName: "Sale property report and confirmation",
      description: "Business Manager-owned property report generation followed by confirmation email delivery.",
      ownerKey: "business-manager",
      connectorKey: BUSINESS_MANAGER_REAL_ESTATE_MANIFEST.connectorKey,
      configurationSchema: {
        type: "object",
        additionalProperties: false,
        required: ["trigger", "reportFormat", "delivery", "requiredAuthorization", "retryOwnership"],
        properties: {
          trigger: { const: "sale-booking-committed" },
          reportFormat: { const: "pdf" },
          delivery: { const: "booking-confirmation-email" },
          requiredAuthorization: { const: "booking-explicit-user-review" },
          retryOwnership: { const: "business-manager" },
        },
      },
      requiredAuthorization: ["booking-explicit-user-review"],
      statusOperationId: "workflow.status",
      retry: { support: "unsupported" },
      parseConfiguration: (value) => propertyReportWorkflowConfiguration.parse(value),
      getStatus: async (workflowRef) => {
        const value = (await client.getWorkflowStatus(workflowRef)).operation;
        return { operationRef: value.operationRef, status: value.status, updatedAt: value.updatedAt,
          ...(value.status === "failed" ? { retryable: false } : {}),
          ...(value.detail ? { extension: value.detail } : {}) };
      },
    }],
    analyticsMetrics: [
      {
        metricKey: "real-estate.inspection-booking.confirmed",
        version: 1,
        displayName: "Confirmed inspection bookings",
        description: "Inspection bookings whose canonical booking command returned a source-confirmed success outcome.",
        unit: "count",
        evidenceClass: "source_confirmed",
        denominatorMetricKey: "tools.attempted",
        source: { kind: "canonical_tool_outcome", canonicalToolId: "booking.commit", outcomeClass: "success" },
      },
      {
        metricKey: "real-estate.confirmation-resend.confirmed",
        version: 1,
        displayName: "Confirmed confirmation resends",
        description: "Confirmation resends whose canonical delivery command returned a source-confirmed success outcome.",
        unit: "count",
        evidenceClass: "source_confirmed",
        denominatorMetricKey: "tools.attempted",
        source: { kind: "canonical_tool_outcome", canonicalToolId: "delivery.commit-resend", outcomeClass: "success" },
      },
    ],
  };
}
