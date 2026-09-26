import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { BusinessPackRegistry } from "../../business-packs/business-pack.registry.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import {
  AssignEscalationCaseSchema, CaseRevisionSchema, CreateEscalationCaseSchema, CreateEscalationDestinationSchema,
  CreateEscalationPolicySchema, CreateEscalationPolicyVersionSchema, EscalationPolicyConfigurationSchema,
  ResolveEscalationCaseSchema, UpdateEscalationDestinationSchema,
} from "./escalation-admin.contracts.js";

type DestinationRow = { escalation_destination_id: string; destination_key: string; display_name: string; channel: string;
  connector_binding_id: string | null; availability: string; status: string; revision: number };
type PolicyVersionRow = { escalation_policy_version_id: string; escalation_policy_id: string; version: number;
  status: string; configuration: unknown };
type CaseRow = { escalation_case_id: string; escalation_policy_version_id: string; escalation_destination_id: string;
  source_session_id: string | null; reason_code: string; summary: string; contact_preference: string | null;
  priority: string; status: string; delivery_status: string; transfer_status: string;
  assigned_to_identity: string | null; resolution_code: string | null; resolution_note: string | null;
  revision: number; created_at: Date | string; updated_at: Date | string; resolved_at: Date | string | null };

@Injectable()
export class EscalationAdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BusinessPackRegistry) private readonly packs: BusinessPackRegistry,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  channelRegistry() {
    const compiledHandoffConnectors = this.packs.connectorManifests().filter((manifest) =>
      manifest.operations.some((operation) => operation.operationId === "handoff.request" && operation.enabled) &&
      manifest.operations.some((operation) => operation.operationId === "handoff.status" && operation.enabled));
    return { channels: [
      { channel: "operations_inbox", availability: "supported", semantics: "case_queued" },
      { channel: "callback", availability: "unsupported", semantics: "callback_requested",
        reason: compiledHandoffConnectors.length
          ? "A compiled connector declares handoff operations but no Admin handoff adapter is registered."
          : "No compiled connector declares callback handoff operations." },
      { channel: "notification", availability: "unsupported", semantics: "notification_accepted",
        reason: "No compiled notification connector is registered." },
      { channel: "live_transfer", availability: "unsupported", semantics: "live_connected",
        reason: "No connector declares verified live-transfer connectivity." },
    ] };
  }

  async listDestinations(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<DestinationRow>(
      `SELECT escalation_destination_id, destination_key, display_name, channel, connector_binding_id,
              availability, status, revision FROM ${schema}.escalation_destinations
       WHERE customer_id = $1 ORDER BY destination_key`, [tenantId],
    ));
    return { destinations: result.rows.map(destination) };
  }

  async createDestination(tenantId: string, actorId: string, input: unknown) {
    const value = CreateEscalationDestinationSchema.parse(input);
    const supported = value.channel === "operations_inbox";
    if (value.channel === "operations_inbox" && value.connectorBindingId) {
      throw new UnprocessableEntityException("The internal operations inbox does not use a connector binding.");
    }
    if (value.channel !== "operations_inbox" && !value.connectorBindingId) {
      throw new UnprocessableEntityException("External escalation destinations require a connector binding.");
    }
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      if (value.connectorBindingId) await this.assertConnector(client, schema, tenantId, value.connectorBindingId);
      const result = await client.query<DestinationRow>(
        `INSERT INTO ${schema}.escalation_destinations
           (customer_id, destination_key, display_name, channel, connector_binding_id, availability, status, created_by_identity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING escalation_destination_id, destination_key, display_name, channel, connector_binding_id,
                   availability, status, revision`,
        [tenantId, value.destinationKey, value.displayName, value.channel, value.connectorBindingId ?? null,
          supported ? "supported" : "unsupported", supported ? "active" : "inactive", actorId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.escalation_destination.created",
        permission: "escalations.configure", outcome: "allowed", resourceType: "escalation_destination",
        resourceId: result.rows[0].escalation_destination_id,
        metadata: { channel: value.channel, availability: supported ? "supported" : "unsupported" } }, client);
      return destination(result.rows[0]);
    });
  }

  async updateDestination(tenantId: string, destinationId: string, actorId: string, input: unknown) {
    const value = UpdateEscalationDestinationSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<DestinationRow>(
        `UPDATE ${schema}.escalation_destinations SET display_name = $3, status = $4,
                revision = revision + 1, updated_at = now()
         WHERE escalation_destination_id = $1 AND customer_id = $2 AND revision = $5
           AND ($4 <> 'active' OR availability = 'supported')
         RETURNING escalation_destination_id, destination_key, display_name, channel, connector_binding_id,
                   availability, status, revision`,
        [destinationId, tenantId, value.displayName, value.status, value.expectedRevision],
      );
      if (!result.rowCount) throw new ConflictException("Destination changed, is unavailable, or cannot be activated.");
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.escalation_destination.updated",
        permission: "escalations.configure", outcome: "allowed", resourceType: "escalation_destination",
        resourceId: destinationId, metadata: { status: value.status } }, client);
      return destination(result.rows[0]);
    });
  }

  async listPolicies(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT p.escalation_policy_id, p.policy_key, p.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'escalationPolicyVersionId', v.escalation_policy_version_id, 'version', v.version,
                'status', v.status, 'configuration', v.configuration, 'publishedAt', v.published_at,
                'createdAt', v.created_at
              ) ORDER BY v.version DESC) FILTER (WHERE v.escalation_policy_version_id IS NOT NULL), '[]'::jsonb) AS versions
       FROM ${schema}.escalation_policies p
       LEFT JOIN ${schema}.escalation_policy_versions v ON v.escalation_policy_id = p.escalation_policy_id
       WHERE p.customer_id = $1 GROUP BY p.escalation_policy_id ORDER BY p.policy_key`, [tenantId],
    ));
    return { policies: result.rows };
  }

  async createPolicy(tenantId: string, actorId: string, input: unknown) {
    const value = CreateEscalationPolicySchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      await this.assertPolicyDestinations(client, schema, tenantId, value.configuration);
      const policy = await client.query<{ escalation_policy_id: string }>(
        `INSERT INTO ${schema}.escalation_policies (customer_id, policy_key, created_by_identity)
         VALUES ($1, $2, $3) RETURNING escalation_policy_id`, [tenantId, value.policyKey, actorId],
      );
      const version = await this.insertPolicyVersion(client, schema, tenantId, policy.rows[0].escalation_policy_id,
        1, value.configuration, actorId);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.escalation_policy.created",
        permission: "escalations.configure", outcome: "allowed", resourceType: "escalation_policy",
        resourceId: policy.rows[0].escalation_policy_id }, client);
      return policyVersion(version);
    });
  }

  async createPolicyVersion(tenantId: string, policyId: string, actorId: string, input: unknown) {
    const value = CreateEscalationPolicyVersionSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const policy = await client.query(
        `SELECT 1 FROM ${schema}.escalation_policies WHERE escalation_policy_id = $1 AND customer_id = $2 FOR UPDATE`,
        [policyId, tenantId],
      );
      if (!policy.rowCount) throw new NotFoundException("Escalation policy not found.");
      await this.assertPolicyDestinations(client, schema, tenantId, value.configuration);
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ${schema}.escalation_policy_versions WHERE escalation_policy_id = $1`,
        [policyId],
      );
      const version = await this.insertPolicyVersion(client, schema, tenantId, policyId, Number(next.rows[0].version),
        value.configuration, actorId);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.escalation_policy.version_created",
        permission: "escalations.configure", outcome: "allowed", resourceType: "escalation_policy_version",
        resourceId: version.escalation_policy_version_id }, client);
      return policyVersion(version);
    });
  }

  async publishPolicy(tenantId: string, versionId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const current = await client.query<PolicyVersionRow>(
        `SELECT escalation_policy_version_id, escalation_policy_id, version, status, configuration
         FROM ${schema}.escalation_policy_versions WHERE escalation_policy_version_id = $1 AND customer_id = $2 FOR UPDATE`,
        [versionId, tenantId],
      );
      if (!current.rowCount || current.rows[0].status !== "draft") {
        throw new ConflictException("Escalation policy version is unavailable or already published.");
      }
      const configuration = EscalationPolicyConfigurationSchema.parse(current.rows[0].configuration);
      await this.assertPolicyDestinations(client, schema, tenantId, configuration);
      const result = await client.query<PolicyVersionRow>(
        `UPDATE ${schema}.escalation_policy_versions SET status = 'published', published_by_identity = $3, published_at = now()
         WHERE escalation_policy_version_id = $1 AND customer_id = $2
         RETURNING escalation_policy_version_id, escalation_policy_id, version, status, configuration`,
        [versionId, tenantId, actorId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.escalation_policy.published",
        permission: "escalations.configure", outcome: "allowed", resourceType: "escalation_policy_version", resourceId: versionId }, client);
      return policyVersion(result.rows[0]);
    });
  }

  async createCase(tenantId: string, actorId: string, input: unknown) {
    const value = CreateEscalationCaseSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const policy = await client.query<PolicyVersionRow>(
        `SELECT escalation_policy_version_id, escalation_policy_id, version, status, configuration
         FROM ${schema}.escalation_policy_versions
         WHERE escalation_policy_version_id = $1 AND customer_id = $2 AND status = 'published'`,
        [value.escalationPolicyVersionId, tenantId],
      );
      if (!policy.rowCount) throw new UnprocessableEntityException("A published tenant escalation policy is required.");
      const configuration = EscalationPolicyConfigurationSchema.parse(policy.rows[0].configuration);
      const rule = configuration.rules.find((candidate) => candidate.reasonCodes.includes(value.reasonCode));
      const destinationId = rule?.destinationId ?? configuration.defaultDestinationId;
      const target = await client.query<DestinationRow>(
        `SELECT escalation_destination_id, destination_key, display_name, channel, connector_binding_id,
                availability, status, revision FROM ${schema}.escalation_destinations
         WHERE escalation_destination_id = $1 AND customer_id = $2 AND availability = 'supported' AND status = 'active'`,
        [destinationId, tenantId],
      );
      if (!target.rowCount) throw new UnprocessableEntityException("The selected escalation destination is unavailable.");
      if (target.rows[0].channel !== "operations_inbox") {
        throw new UnprocessableEntityException("No external handoff adapter is registered; the escalation remains unavailable.");
      }
      const result = await client.query<CaseRow>(
        `INSERT INTO ${schema}.escalation_cases
           (customer_id, escalation_policy_version_id, escalation_destination_id, source_session_id,
            reason_code, summary, contact_preference, priority, delivery_status, transfer_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 'not_requested')
         RETURNING *`,
        [tenantId, value.escalationPolicyVersionId, destinationId, value.sourceSessionId ?? null,
          value.reasonCode, value.summary, value.contactPreference ?? null, rule?.priority ?? "normal"],
      );
      await this.event(client, schema, tenantId, result.rows[0], "created", actorId, {});
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.escalation_case.created",
        permission: "escalations.assign", outcome: "allowed", resourceType: "escalation_case",
        resourceId: result.rows[0].escalation_case_id, metadata: { reasonCode: value.reasonCode } }, client);
      return escalationCase(result.rows[0]);
    });
  }

  async listCases(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<CaseRow>(
      `SELECT * FROM ${schema}.escalation_cases WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`, [tenantId],
    ));
    return { cases: result.rows.map(escalationCase) };
  }

  async getCase(tenantId: string, caseId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<CaseRow>(
        `SELECT * FROM ${schema}.escalation_cases WHERE escalation_case_id = $1 AND customer_id = $2`,
        [caseId, tenantId],
      );
      if (!result.rowCount) throw new NotFoundException("Escalation case not found.");
      const events = await client.query(
        `SELECT escalation_case_event_id, event_type, status, delivery_status, transfer_status,
                actor_identity, metadata, created_at
         FROM ${schema}.escalation_case_events
         WHERE escalation_case_id = $1 AND customer_id = $2 ORDER BY created_at`, [caseId, tenantId],
      );
      return { ...escalationCase(result.rows[0]), events: events.rows };
    });
  }

  assignCase(tenantId: string, caseId: string, actorId: string, input: unknown) {
    const value = AssignEscalationCaseSchema.parse(input);
    return this.transitionCase(tenantId, caseId, actorId, value.expectedRevision, "assigned", "assigned",
      { assignedToIdentity: value.assignedToIdentity });
  }

  startCase(tenantId: string, caseId: string, actorId: string, input: unknown) {
    const value = CaseRevisionSchema.parse(input);
    return this.transitionCase(tenantId, caseId, actorId, value.expectedRevision, "in_progress", "started", {});
  }

  async resolveCase(tenantId: string, caseId: string, actorId: string, input: unknown) {
    const value = ResolveEscalationCaseSchema.parse(input);
    return this.transitionCase(tenantId, caseId, actorId, value.expectedRevision, "resolved", "resolved",
      { resolutionCode: value.resolutionCode, resolutionNote: value.resolutionNote });
  }

  private async transitionCase(tenantId: string, caseId: string, actorId: string, expectedRevision: number,
    status: "assigned" | "in_progress" | "resolved", eventType: "assigned" | "started" | "resolved",
    values: { assignedToIdentity?: string; resolutionCode?: string; resolutionNote?: string }) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<CaseRow>(
        `UPDATE ${schema}.escalation_cases SET status = $3,
                assigned_to_identity = COALESCE($4, assigned_to_identity),
                resolution_code = COALESCE($5, resolution_code), resolution_note = COALESCE($6, resolution_note),
                resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE resolved_at END,
                revision = revision + 1, updated_at = now()
         WHERE escalation_case_id = $1 AND customer_id = $2 AND revision = $7
           AND status <> 'resolved'
           AND (($3 = 'assigned' AND status IN ('open', 'assigned'))
             OR ($3 = 'in_progress' AND status IN ('open', 'assigned'))
             OR ($3 = 'resolved' AND status IN ('open', 'assigned', 'in_progress')))
         RETURNING *`,
        [caseId, tenantId, status, values.assignedToIdentity ?? null, values.resolutionCode ?? null,
          values.resolutionNote ?? null, expectedRevision],
      );
      if (!result.rowCount) throw new ConflictException("Escalation case changed or cannot make that transition.");
      await this.event(client, schema, tenantId, result.rows[0], eventType, actorId, {});
      const permission = status === "resolved" ? "escalations.resolve" as const : "escalations.assign" as const;
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: `admin.escalation_case.${eventType}`,
        permission, outcome: "allowed", resourceType: "escalation_case", resourceId: caseId }, client);
      return escalationCase(result.rows[0]);
    });
  }

  private insertPolicyVersion(client: PoolClient, schema: string, tenantId: string, policyId: string, version: number,
    configuration: unknown, actorId: string) {
    return client.query<PolicyVersionRow>(
      `INSERT INTO ${schema}.escalation_policy_versions
         (escalation_policy_id, customer_id, version, configuration, created_by_identity)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING escalation_policy_version_id, escalation_policy_id, version, status, configuration`,
      [policyId, tenantId, version, JSON.stringify(configuration), actorId],
    ).then((result) => result.rows[0]);
  }

  private async assertPolicyDestinations(client: PoolClient, schema: string, tenantId: string,
    configuration: ReturnType<typeof EscalationPolicyConfigurationSchema.parse>) {
    const ids = [...new Set([configuration.defaultDestinationId, ...configuration.rules.map((rule) => rule.destinationId)])];
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${schema}.escalation_destinations
       WHERE escalation_destination_id = ANY($1::uuid[]) AND customer_id = $2
         AND availability = 'supported' AND status = 'active'`, [ids, tenantId],
    );
    if (Number(result.rows[0]?.count ?? 0) !== ids.length) {
      throw new UnprocessableEntityException("Escalation policies may reference only active, supported tenant destinations.");
    }
  }

  private async assertConnector(client: PoolClient, schema: string, tenantId: string, connectorBindingId: string) {
    const result = await client.query<{ connector_key: string }>(
      `SELECT connector_key FROM ${schema}.connector_bindings
       WHERE connector_binding_id = $1 AND customer_id = $2`, [connectorBindingId, tenantId],
    );
    if (!result.rowCount || !this.packs.connectorManifests().some((manifest) => manifest.connectorKey === result.rows[0].connector_key)) {
      throw new UnprocessableEntityException("A tenant connector from a compiled business pack is required.");
    }
  }

  private event(client: PoolClient, schema: string, tenantId: string, row: CaseRow, eventType: string,
    actorId: string | null, metadata: Record<string, unknown>) {
    return client.query(
      `INSERT INTO ${schema}.escalation_case_events
         (customer_id, escalation_case_id, event_type, status, delivery_status, transfer_status, actor_identity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [tenantId, row.escalation_case_id, eventType, row.status, row.delivery_status, row.transfer_status,
        actorId, JSON.stringify(metadata)],
    );
  }
}

function destination(row: DestinationRow) {
  return { escalationDestinationId: row.escalation_destination_id, destinationKey: row.destination_key,
    displayName: row.display_name, channel: row.channel, connectorBindingId: row.connector_binding_id,
    availability: row.availability, status: row.status, revision: row.revision };
}
function policyVersion(row: PolicyVersionRow) {
  return { escalationPolicyVersionId: row.escalation_policy_version_id, escalationPolicyId: row.escalation_policy_id,
    version: row.version, status: row.status, configuration: row.configuration };
}
function escalationCase(row: CaseRow) {
  return { escalationCaseId: row.escalation_case_id, escalationPolicyVersionId: row.escalation_policy_version_id,
    escalationDestinationId: row.escalation_destination_id, sourceSessionId: row.source_session_id,
    reasonCode: row.reason_code, summary: row.summary, contactPreference: row.contact_preference,
    priority: row.priority, status: row.status, deliveryStatus: row.delivery_status,
    transferStatus: row.transfer_status, assignedToIdentity: row.assigned_to_identity,
    resolutionCode: row.resolution_code, resolutionNote: row.resolution_note, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at };
}
