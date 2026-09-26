import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { BusinessPackRegistry } from "../../business-packs/business-pack.registry.js";
import type { BusinessPackRegistration } from "../../business-packs/business-pack.contracts.js";
import { ToolConnectorAdminService } from "./tool-connector-admin.service.js";
import { z } from "zod";

const tenantId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";

describe("approved tool and connector administration", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("exposes only safe compiled registry metadata and keeps sandbox tests synthetic", () => {
    const service = createService(jest.fn(), jest.fn(async (externalAccountId: string) => ({ externalAccountId })));
    expect(service.connectorRegistry()).toMatchObject({
      connectors: [{ connectorKey: "approved-connector", authMode: "runtime-scoped-token" }],
    });
    expect(service.registry()).toMatchObject({
      operations: expect.arrayContaining([expect.objectContaining({ operationId: "catalog.search" })]),
      tools: expect.arrayContaining([expect.objectContaining({
        toolId: "catalog.search", inputSchema: expect.objectContaining({ type: "object" }),
      })]),
    });
    expect(JSON.stringify({ tools: service.registry(), connectors: service.connectorRegistry() }))
      .not.toMatch(/credentialReference|secret:\/\//i);
    expect(service.sandbox("booking.commit")).toMatchObject({
      mode: "synthetic-contract-only", externalEffects: false, policyDecision: "review-required",
    });
  });

  it("lists tenant profile versions for capability authoring without configuration or secrets", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        businessProfileVersionId: "44444444-4444-4444-8444-444444444444",
        profileKey: "support", displayName: "Support", version: 2, revision: 3,
        status: "draft", packRegistrationKey: null,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [capabilityRow()], rowCount: 1 });
    const result = await createService(transactionWith(query), jest.fn())
      .capabilityAuthoringDependencies(tenantId);
    expect(result.businessProfileVersions[0]).toMatchObject({ status: "draft", editable: true });
    expect(result.capabilityBindings[0]).toMatchObject({ capabilityKey: "catalog" });
    expect(JSON.stringify(result)).not.toMatch(/configuration|credential|secret/i);
    expect(query.mock.calls.every((call) => call[1]?.[0] === tenantId)).toBe(true);
  });

  it("rejects arbitrary connector registrations before database access", async () => {
    const transaction = jest.fn();
    const service = createService(transaction, jest.fn());
    await expect(service.connect(tenantId, "actor", {
      connectorKey: "arbitrary-http", externalAccountId: accountId, requestedScopes: ["http:any"],
    })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("verifies the external account and never returns its server credential reference", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ external_company_id: accountId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const service = createService(transactionWith(query), jest.fn(async () => ({ externalAccountId: accountId })));
    const result = await service.connect(tenantId, "actor", {
      connectorKey: "approved-connector", externalAccountId: accountId, requestedScopes: ["approved:read"],
    });
    expect(result).toMatchObject({ connectorBindingId: bindingId, credentialConfigured: true });
    expect(result).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(result)).not.toContain("secret://server-only");
    expect(query.mock.calls[2]?.[1]).toContain("secret://server-only");
  });

  it("rejects a valid connector account that belongs to another organisation", async () => {
    const verifyAccount = jest.fn(async (externalAccountId: string) => ({ externalAccountId }));
    const query = jest.fn().mockResolvedValueOnce({
      rows: [{ external_company_id: "99999999-9999-4999-8999-999999999999" }], rowCount: 1,
    });
    const service = createService(transactionWith(query), verifyAccount);
    await expect(service.connect(tenantId, "actor", {
      connectorKey: "approved-connector", externalAccountId: accountId, requestedScopes: ["approved:read"],
    })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(verifyAccount).not.toHaveBeenCalled();
  });

  it("keeps a binding in disconnecting state while command outcomes require reconciliation", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [row()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...row(), status: "disconnecting", revision: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const service = createService(transactionWith(query), jest.fn());
    await expect(service.disconnect(tenantId, bindingId, "actor", { expectedRevision: 1 })).resolves.toMatchObject({
      status: "disconnecting", unresolvedCommandCount: 2, reconciliationRequired: true,
    });
    expect(query.mock.calls[1]?.[0]).toContain("outcome_unknown");
    expect(query.mock.calls.some((call) => String(call[0]).match(/UPDATE.+tool_calls/s))).toBe(false);
  });

  it("rejects cross-tenant or inactive connector selection for a capability grant", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ status: "draft" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const service = createService(transactionWith(query), jest.fn());
    await expect(service.putCapabilityBinding(
      tenantId, "44444444-4444-4444-8444-444444444444", "catalog", "actor",
      { connectorBindingId: bindingId, enabled: true },
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(query.mock.calls[1]?.[1]).toEqual([bindingId, tenantId]);
  });
});

function row() {
  return {
    connector_binding_id: bindingId,
    connector_key: "approved-connector",
    external_account_id: accountId,
    allowed_scopes: ["approved:read"],
    status: "active",
    revision: 1,
    health_status: "healthy",
    health_checked_at: new Date("2026-09-24T00:00:00Z"),
    last_error_code: null,
  };
}

function capabilityRow() {
  return {
    capability_binding_id: "55555555-5555-4555-8555-555555555555",
    business_profile_version_id: "44444444-4444-4444-8444-444444444444",
    capability_key: "catalog",
    connector_key: "approved-connector",
    connector_binding_id: bindingId,
    policy_version: "compiled:test@1.0.0",
    enabled: true,
    revision: 2,
  };
}

function createService(transaction: jest.Mock, verifyAccount: jest.Mock) {
  const registration: BusinessPackRegistration = {
    manifest: {
      packId: "approved-pack", version: "1.0.0", toolCatalogVersion: "approved-v1",
      connectorKeys: ["approved-connector"], capabilities: ["catalog", "booking"],
      operations: ["catalog.search", "booking.commit"], schemaExtensionIds: [], uiRendererIds: [], legacyAliases: {},
    },
    connectorManifest: {
      connectorKey: "approved-connector", version: "1.0.0", operations: [
        { operationId: "catalog.search", enabled: true, idempotency: "not-applicable", reconciliation: "unsupported", cancellation: "unsupported", liveStatus: "none" },
        { operationId: "booking.commit", enabled: true, idempotency: "stable-command", reconciliation: "lookup", cancellation: "before-commit", liveStatus: "none" },
      ],
    },
    tools: [{
      definition: { name: "catalog.search", description: "Search the approved catalog.",
        parameters: { type: "object", additionalProperties: false, properties: {} } },
      inputSchema: z.object({}),
      policy: {
        toolId: "catalog.search", version: "1.0.0", requiredCapability: "catalog",
        requiredScopes: ["approved:read"], riskClass: "low", sideEffectClass: "read",
        confirmationPolicy: "none", timeoutMs: 8_000, retryPolicy: "safe-read",
        idempotencyPolicy: "not-applicable",
      },
      execute: async () => ({}),
    }], instructionFragments: { canonical: [], legacy: [] }, operationIds: ["catalog.search", "booking.commit"],
    connectorAdministration: {
      connectorKey: "approved-connector", displayName: "Approved connector", authMode: "runtime-scoped-token",
      accountBindingMode: "tenant-external-company",
      allowedScopes: ["approved:read"], credentialReference: "secret://server-only", verifyAccount,
    },
    workflowTemplates: [],
    analyticsMetrics: [],
  };
  return new ToolConnectorAdminService(
    { tenantTransaction: transaction } as never,
    new BusinessPackRegistry([registration]),
    { record: jest.fn() } as never,
  );
}

function transactionWith(query: jest.Mock) {
  return jest.fn(async (_tenantId: string, work: (client: PoolClient) => unknown) =>
    work({ query } as unknown as PoolClient));
}
