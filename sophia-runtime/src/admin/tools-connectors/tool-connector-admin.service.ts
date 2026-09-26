import {
  ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { BusinessPackRegistry } from "../../business-packs/business-pack.registry.js";
import { SHARED_CAPABILITY_CATALOG } from "../../capabilities-v2/catalog/shared-capability.catalog.js";
import { CapabilityOperationIdSchema } from "../../capabilities-v2/contracts/business-capability.contracts.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import {
  CreateConnectorBindingSchema, PutCapabilityBindingSchema, RevisionCommandSchema,
} from "./tool-connector-admin.contracts.js";

type ConnectorBindingRow = {
  connector_binding_id: string; connector_key: string; external_account_id: string;
  allowed_scopes: unknown; status: string; revision: number; health_status: string;
  health_checked_at: Date | string | null; last_error_code: string | null;
};
type CapabilityBindingRow = {
  capability_binding_id: string; business_profile_version_id: string; capability_key: string;
  connector_key: string; connector_binding_id: string | null; policy_version: string;
  enabled: boolean; revision: number;
};

@Injectable()
export class ToolConnectorAdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BusinessPackRegistry) private readonly packs: BusinessPackRegistry,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  registry() {
    const packManifests = this.packs.manifests();
    return {
      catalogVersion: this.packs.catalogVersion(),
      packs: packManifests,
      tools: this.packs.tools().flatMap((tool) => tool.policy ? [{
        toolId: tool.policy.toolId,
        version: tool.policy.version,
        description: tool.definition.description,
        inputSchema: tool.definition.parameters,
        requiredCapability: tool.policy.requiredCapability,
        requiredScopes: tool.policy.requiredScopes,
        riskClass: tool.policy.riskClass,
        sideEffectClass: tool.policy.sideEffectClass,
        confirmationPolicy: tool.policy.confirmationPolicy,
        timeoutMs: tool.policy.timeoutMs,
        retryPolicy: tool.policy.retryPolicy,
        idempotencyPolicy: tool.policy.idempotencyPolicy,
      }] : []),
      operations: SHARED_CAPABILITY_CATALOG
        .filter(({ operationId }) => packManifests.some((pack) => pack.operations.includes(operationId)))
        .map((entry) => ({ ...entry, contractVersion: "capability-contract-v1" })),
    };
  }

  async capabilityAuthoringDependencies(tenantId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const [profiles, bindings] = await Promise.all([
        client.query(
          `SELECT v.business_profile_version_id AS "businessProfileVersionId",
                  p.profile_key AS "profileKey", p.display_name AS "displayName",
                  v.version, v.revision, v.status,
                  v.pack_registration_key AS "packRegistrationKey"
           FROM ${schema}.business_profile_versions v
           JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
           WHERE p.customer_id = $1
           ORDER BY p.profile_key, v.version DESC`,
          [tenantId],
        ),
        client.query<CapabilityBindingRow>(
          `SELECT b.capability_binding_id, b.business_profile_version_id, b.capability_key,
                  b.connector_key, b.connector_binding_id, b.policy_version, b.enabled, b.revision
           FROM ${schema}.capability_bindings b
           JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id = b.business_profile_version_id
           JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
           WHERE p.customer_id = $1
           ORDER BY b.capability_key`,
          [tenantId],
        ),
      ]);
      return {
        businessProfileVersions: profiles.rows.map((profile) => ({
          ...profile,
          editable: profile.status === "draft",
        })),
        capabilityBindings: bindings.rows.map(capabilityBinding),
      };
    });
  }

  connectorRegistry() {
    const manifests = new Map(this.packs.connectorManifests().map((manifest) => [manifest.connectorKey, manifest]));
    return { connectors: this.packs.connectorRegistrations().map((registration) => ({
      connectorKey: registration.connectorKey,
      displayName: registration.displayName,
      authMode: registration.authMode,
      accountBindingMode: registration.accountBindingMode,
      allowedScopes: registration.allowedScopes,
      supportsCredentialRotation: false,
      manifest: manifests.get(registration.connectorKey),
    })) };
  }

  sandbox(operationId: string) {
    const parsed = CapabilityOperationIdSchema.parse(operationId);
    if (!this.packs.manifests().some((pack) => pack.operations.includes(parsed))) {
      throw new UnprocessableEntityException("Operation is not approved by a compiled business pack.");
    }
    const policy = SHARED_CAPABILITY_CATALOG.find((entry) => entry.operationId === parsed);
    if (!policy) throw new UnprocessableEntityException("Operation policy is unavailable.");
    return {
      operationId: parsed,
      mode: "synthetic-contract-only",
      externalEffects: false,
      policyDecision: policy.confirmationPolicy === "explicit-user-review" ? "review-required" : "allowed",
      sideEffectClass: policy.sideEffectClass,
      note: "No connector, provider, email or business mutation was invoked.",
    };
  }

  async listConnectorBindings(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<ConnectorBindingRow>(
      `SELECT connector_binding_id, connector_key, external_account_id, allowed_scopes,
              status, revision, health_status, health_checked_at, last_error_code
       FROM ${schema}.connector_bindings WHERE customer_id = $1 ORDER BY created_at`, [tenantId],
    ));
    return { bindings: result.rows.map(safeConnectorBinding) };
  }

  async connect(tenantId: string, actorId: string, input: unknown) {
    const value = CreateConnectorBindingSchema.parse(input);
    const registration = this.registration(value.connectorKey);
    const scopes = [...new Set(value.requestedScopes)];
    if (scopes.some((candidate) => !registration.allowedScopes.includes(candidate))) {
      throw new UnprocessableEntityException("Requested connector scopes are not approved by the compiled connector registration.");
    }
    await this.assertTenantAccount(tenantId, value.externalAccountId, registration.accountBindingMode);
    await registration.verifyAccount(value.externalAccountId);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM ${schema}.connector_bindings WHERE customer_id = $1 AND connector_key = $2 AND external_account_id = $3`,
        [tenantId, value.connectorKey, value.externalAccountId],
      );
      if (existing.rowCount) throw new ConflictException("This connector account is already bound to the organisation.");
      const inserted = await client.query<ConnectorBindingRow>(
        `INSERT INTO ${schema}.connector_bindings
           (customer_id, connector_key, external_account_id, credential_ref, allowed_scopes,
            status, health_status, health_checked_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'active', 'healthy', now())
         RETURNING connector_binding_id, connector_key, external_account_id, allowed_scopes,
                   status, revision, health_status, health_checked_at, last_error_code`,
        [tenantId, value.connectorKey, value.externalAccountId, registration.credentialReference, JSON.stringify(scopes)],
      );
      const binding = inserted.rows[0];
      await this.event(client, tenantId, binding.connector_binding_id, "connected", "active", actorId, 0);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.connector.connected",
        permission: "connectors.manage", outcome: "allowed", resourceType: "connector_binding",
        resourceId: binding.connector_binding_id, metadata: { connectorKey: value.connectorKey, scopes } }, client);
      return safeConnectorBinding(binding);
    });
  }

  async test(tenantId: string, bindingId: string, actorId: string) {
    const binding = await this.getConnectorBinding(tenantId, bindingId);
    const registration = this.registration(binding.connector_key);
    try {
      await registration.verifyAccount(binding.external_account_id);
      return await this.recordTest(tenantId, binding, actorId, "healthy", null);
    } catch {
      await this.recordTest(tenantId, binding, actorId, "unhealthy", "CONNECTOR_IDENTITY_OR_HEALTH_FAILED");
      throw new UnprocessableEntityException("Connector identity or health verification failed.");
    }
  }

  async reconnect(tenantId: string, bindingId: string, actorId: string, input: unknown) {
    const { expectedRevision } = RevisionCommandSchema.parse(input);
    const binding = await this.getConnectorBinding(tenantId, bindingId);
    const registration = this.registration(binding.connector_key);
    await this.assertTenantAccount(tenantId, binding.external_account_id, registration.accountBindingMode);
    await registration.verifyAccount(binding.external_account_id);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<ConnectorBindingRow>(
        `UPDATE ${schema}.connector_bindings SET status = 'active', health_status = 'healthy',
                health_checked_at = now(), last_error_code = NULL, disconnected_at = NULL,
                revision = revision + 1, updated_at = now()
         WHERE connector_binding_id = $1 AND customer_id = $2 AND revision = $3
         RETURNING connector_binding_id, connector_key, external_account_id, allowed_scopes,
                   status, revision, health_status, health_checked_at, last_error_code`,
        [bindingId, tenantId, expectedRevision],
      );
      if (!result.rowCount) throw new ConflictException("Connector binding revision has changed.");
      await this.event(client, tenantId, bindingId, "reconnected", "active", actorId, 0);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.connector.reconnected",
        permission: "connectors.manage", outcome: "allowed", resourceType: "connector_binding", resourceId: bindingId }, client);
      return safeConnectorBinding(result.rows[0]);
    });
  }

  async disconnect(tenantId: string, bindingId: string, actorId: string, input: unknown) {
    const { expectedRevision } = RevisionCommandSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const current = await client.query<ConnectorBindingRow>(
        `SELECT connector_binding_id, connector_key, external_account_id, allowed_scopes,
                status, revision, health_status, health_checked_at, last_error_code
         FROM ${schema}.connector_bindings WHERE connector_binding_id = $1 AND customer_id = $2 FOR UPDATE`,
        [bindingId, tenantId],
      );
      if (!current.rowCount) throw new NotFoundException("Connector binding not found.");
      if (current.rows[0].revision !== expectedRevision) throw new ConflictException("Connector binding revision has changed.");
      const unresolved = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${schema}.tool_calls t
         JOIN ${schema}.capability_bindings b ON b.capability_binding_id = t.capability_binding_id
         WHERE t.customer_id = $1 AND b.connector_binding_id = $2
           AND t.status IN ('accepted', 'executing', 'unknown', 'outcome_unknown')`,
        [tenantId, bindingId],
      );
      const unresolvedCommandCount = Number(unresolved.rows[0]?.count ?? 0);
      const status = unresolvedCommandCount ? "disconnecting" : "revoked";
      const updated = await client.query<ConnectorBindingRow>(
        `UPDATE ${schema}.connector_bindings SET status = $3,
                disconnected_at = CASE WHEN $3 = 'revoked' THEN now() ELSE NULL END,
                revision = revision + 1, updated_at = now()
         WHERE connector_binding_id = $1 AND customer_id = $2
         RETURNING connector_binding_id, connector_key, external_account_id, allowed_scopes,
                   status, revision, health_status, health_checked_at, last_error_code`,
        [bindingId, tenantId, status],
      );
      await this.event(client, tenantId, bindingId,
        status === "revoked" ? "disconnected" : "disconnect_requested", status, actorId, unresolvedCommandCount);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: `admin.connector.${status}`,
        permission: "connectors.manage", outcome: "allowed", resourceType: "connector_binding", resourceId: bindingId,
        metadata: { unresolvedCommandCount } }, client);
      return { ...safeConnectorBinding(updated.rows[0]), unresolvedCommandCount,
        reconciliationRequired: unresolvedCommandCount > 0 };
    });
  }

  async listCapabilityBindings(tenantId: string, businessProfileVersionId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<CapabilityBindingRow>(
      `SELECT b.capability_binding_id, b.business_profile_version_id, b.capability_key,
              b.connector_key, b.connector_binding_id, b.policy_version, b.enabled, b.revision
       FROM ${schema}.capability_bindings b
       JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id = b.business_profile_version_id
       JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
       WHERE b.business_profile_version_id = $1 AND p.customer_id = $2 ORDER BY b.capability_key`,
      [businessProfileVersionId, tenantId],
    ));
    return { bindings: result.rows.map(capabilityBinding) };
  }

  async putCapabilityBinding(
    tenantId: string, businessProfileVersionId: string, capabilityKey: string, actorId: string, input: unknown,
  ) {
    const value = PutCapabilityBindingSchema.parse(input);
    const pack = this.packs.manifests().find((candidate) => candidate.capabilities.includes(capabilityKey));
    if (!pack) throw new UnprocessableEntityException("Capability is not approved by a compiled business pack.");
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const profile = await client.query<{ status: string }>(
        `SELECT v.status FROM ${schema}.business_profile_versions v
         JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
         WHERE v.business_profile_version_id = $1 AND p.customer_id = $2 FOR UPDATE`,
        [businessProfileVersionId, tenantId],
      );
      if (!profile.rowCount) throw new NotFoundException("Business profile version not found.");
      if (profile.rows[0].status !== "draft") throw new ConflictException("Only draft business profile versions can be changed.");
      const connector = await client.query<{ connector_key: string }>(
        `SELECT connector_key FROM ${schema}.connector_bindings
         WHERE connector_binding_id = $1 AND customer_id = $2 AND status = 'active'`,
        [value.connectorBindingId, tenantId],
      );
      if (!connector.rowCount || !pack.connectorKeys.includes(connector.rows[0].connector_key)) {
        throw new UnprocessableEntityException("An active compatible tenant connector binding is required.");
      }
      const existing = await client.query<CapabilityBindingRow>(
        `SELECT capability_binding_id, business_profile_version_id, capability_key, connector_key,
                connector_binding_id, policy_version, enabled, revision
         FROM ${schema}.capability_bindings
         WHERE business_profile_version_id = $1 AND capability_key = $2 FOR UPDATE`,
        [businessProfileVersionId, capabilityKey],
      );
      let result;
      if (existing.rowCount) {
        if (value.expectedRevision == null || existing.rows[0].revision !== value.expectedRevision) {
          throw new ConflictException("Capability binding revision has changed.");
        }
        result = await client.query<CapabilityBindingRow>(
          `UPDATE ${schema}.capability_bindings SET connector_key = $3, connector_binding_id = $4,
                  enabled = $5, revision = revision + 1, updated_at = now()
           WHERE business_profile_version_id = $1 AND capability_key = $2
           RETURNING capability_binding_id, business_profile_version_id, capability_key, connector_key,
                     connector_binding_id, policy_version, enabled, revision`,
          [businessProfileVersionId, capabilityKey, connector.rows[0].connector_key, value.connectorBindingId, value.enabled],
        );
      } else {
        if (value.expectedRevision != null) throw new ConflictException("Capability binding does not exist at that revision.");
        result = await client.query<CapabilityBindingRow>(
          `INSERT INTO ${schema}.capability_bindings
             (business_profile_version_id, capability_key, connector_key, connector_binding_id,
              configuration, policy_version, enabled)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6)
           RETURNING capability_binding_id, business_profile_version_id, capability_key, connector_key,
                     connector_binding_id, policy_version, enabled, revision`,
          [businessProfileVersionId, capabilityKey, connector.rows[0].connector_key, value.connectorBindingId,
            `compiled:${pack.packId}@${pack.version}`, value.enabled],
        );
      }
      const binding = result.rows[0];
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.capability_binding.updated",
        permission: "tools.bind", outcome: "allowed", resourceType: "capability_binding",
        resourceId: binding.capability_binding_id, metadata: { capabilityKey, enabled: value.enabled } }, client);
      return capabilityBinding(binding);
    });
  }

  private registration(connectorKey: string) {
    const registration = this.packs.connectorRegistrations().find((candidate) => candidate.connectorKey === connectorKey);
    if (!registration) throw new UnprocessableEntityException("Connector is not approved by a compiled business pack.");
    return registration;
  }

  private async getConnectorBinding(tenantId: string, bindingId: string): Promise<ConnectorBindingRow> {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<ConnectorBindingRow>(
      `SELECT connector_binding_id, connector_key, external_account_id, allowed_scopes,
              status, revision, health_status, health_checked_at, last_error_code
       FROM ${schema}.connector_bindings WHERE connector_binding_id = $1 AND customer_id = $2`,
      [bindingId, tenantId],
    ));
    if (!result.rowCount) throw new NotFoundException("Connector binding not found.");
    return result.rows[0];
  }

  private async assertTenantAccount(
    tenantId: string,
    externalAccountId: string,
    mode: "tenant-external-company" | "connector-verified",
  ): Promise<void> {
    if (mode === "connector-verified") return;
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<{ external_company_id: string }>(
      `SELECT external_company_id FROM ${schema}.customers WHERE customer_id = $1`, [tenantId],
    ));
    if (result.rows[0]?.external_company_id !== externalAccountId) {
      throw new UnprocessableEntityException("Connector account does not belong to the selected organisation.");
    }
  }

  private async recordTest(tenantId: string, binding: ConnectorBindingRow, actorId: string,
    health: "healthy" | "unhealthy", errorCode: string | null) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const updated = await client.query<ConnectorBindingRow>(
        `UPDATE ${schema}.connector_bindings SET health_status = $3, health_checked_at = now(),
                last_error_code = $4, updated_at = now()
         WHERE connector_binding_id = $1 AND customer_id = $2
         RETURNING connector_binding_id, connector_key, external_account_id, allowed_scopes,
                   status, revision, health_status, health_checked_at, last_error_code`,
        [binding.connector_binding_id, tenantId, health, errorCode],
      );
      await this.event(client, tenantId, binding.connector_binding_id, "tested", binding.status, actorId, 0);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.connector.tested",
        permission: "connectors.test", outcome: health === "healthy" ? "allowed" : "failed",
        resourceType: "connector_binding", resourceId: binding.connector_binding_id,
        metadata: { health, errorCode } }, client);
      return safeConnectorBinding(updated.rows[0]);
    });
  }

  private event(client: PoolClient, tenantId: string, bindingId: string, eventType: string,
    status: string, actorId: string, unresolved: number) {
    const schema = runtimeConfig().schema;
    return client.query(
      `INSERT INTO ${schema}.connector_binding_events
         (customer_id, connector_binding_id, event_type, status, unresolved_command_count, created_by_identity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, bindingId, eventType, status, unresolved, actorId],
    );
  }
}

function safeConnectorBinding(row: ConnectorBindingRow) {
  return {
    connectorBindingId: row.connector_binding_id,
    connectorKey: row.connector_key,
    externalAccountId: row.external_account_id,
    allowedScopes: Array.isArray(row.allowed_scopes)
      ? row.allowed_scopes.filter((scope): scope is string => typeof scope === "string") : [],
    status: row.status,
    revision: row.revision,
    healthStatus: row.health_status,
    healthCheckedAt: row.health_checked_at,
    lastErrorCode: row.last_error_code,
    credentialConfigured: true,
  };
}

function capabilityBinding(row: CapabilityBindingRow) {
  return {
    capabilityBindingId: row.capability_binding_id,
    businessProfileVersionId: row.business_profile_version_id,
    capabilityKey: row.capability_key,
    connectorKey: row.connector_key,
    connectorBindingId: row.connector_binding_id,
    policyVersion: row.policy_version,
    enabled: row.enabled,
    revision: row.revision,
  };
}
