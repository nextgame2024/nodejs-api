import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { BusinessPackRegistry } from "../../business-packs/business-pack.registry.js";
import type { WorkflowTemplateRegistration } from "../../business-packs/business-pack.contracts.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import { CreateWorkflowSchema, CreateWorkflowVersionSchema, PinWorkflowRunSchema, RetryWorkflowRunSchema } from "./workflow-admin.contracts.js";

type DefinitionRow = { workflow_definition_id: string; template_key: string };
type VersionRow = { workflow_version_id: string; workflow_definition_id: string; version: number; status: string;
  template_key: string; template_version: string; configuration: unknown; required_authorization: unknown };
type RunRow = { workflow_run_id: string; workflow_version_id: string; capability_binding_id: string; owner_key: string;
  external_run_ref: string; source_session_id: string | null; last_status: string; last_status_at: Date | string | null;
  template_key: string; connector_key: string };

@Injectable()
export class WorkflowAdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BusinessPackRegistry) private readonly packs: BusinessPackRegistry,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  templates() {
    return { templates: this.packs.workflowTemplates().map((template) => ({
      templateKey: template.templateKey, version: template.version, displayName: template.displayName,
      description: template.description, ownerKey: template.ownerKey, connectorKey: template.connectorKey,
      configurationSchema: template.configurationSchema,
      requiredAuthorization: template.requiredAuthorization,
      statusOperationId: template.statusOperationId, retry: { support: template.retry.support },
    })) };
  }

  async list(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT d.workflow_definition_id, d.workflow_key, d.template_key, d.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'workflowVersionId', v.workflow_version_id, 'version', v.version, 'status', v.status,
                'templateVersion', v.template_version, 'configuration', v.configuration,
                'requiredAuthorization', v.required_authorization, 'publishedAt', v.published_at,
                'createdAt', v.created_at
              ) ORDER BY v.version DESC) FILTER (WHERE v.workflow_version_id IS NOT NULL), '[]'::jsonb) AS versions
       FROM ${schema}.workflow_definitions d
       LEFT JOIN ${schema}.workflow_versions v ON v.workflow_definition_id = d.workflow_definition_id
       WHERE d.customer_id = $1 GROUP BY d.workflow_definition_id ORDER BY d.workflow_key`, [tenantId],
    ));
    return { workflows: result.rows };
  }

  async create(tenantId: string, actorId: string, input: unknown) {
    const value = CreateWorkflowSchema.parse(input);
    const template = this.template(value.templateKey);
    const configuration = template.parseConfiguration(value.configuration);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const definition = await client.query<{ workflow_definition_id: string }>(
        `INSERT INTO ${schema}.workflow_definitions (customer_id, workflow_key, template_key, created_by_identity)
         VALUES ($1, $2, $3, $4) RETURNING workflow_definition_id`,
        [tenantId, value.workflowKey, template.templateKey, actorId],
      );
      const version = await this.insertVersion(client, schema, tenantId, definition.rows[0].workflow_definition_id,
        1, template, configuration, actorId);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.workflow.created",
        permission: "workflows.configure", outcome: "allowed", resourceType: "workflow_definition",
        resourceId: definition.rows[0].workflow_definition_id, metadata: { templateKey: template.templateKey } }, client);
      return workflowVersion(version);
    });
  }

  async createVersion(tenantId: string, definitionId: string, actorId: string, input: unknown) {
    const value = CreateWorkflowVersionSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<DefinitionRow>(
        `SELECT workflow_definition_id, template_key FROM ${schema}.workflow_definitions
         WHERE workflow_definition_id = $1 AND customer_id = $2 FOR UPDATE`, [definitionId, tenantId],
      );
      if (!result.rowCount) throw new NotFoundException("Workflow definition not found.");
      const template = this.template(result.rows[0].template_key);
      const configuration = template.parseConfiguration(value.configuration);
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ${schema}.workflow_versions WHERE workflow_definition_id = $1`,
        [definitionId],
      );
      const version = await this.insertVersion(client, schema, tenantId, definitionId, Number(next.rows[0].version),
        template, configuration, actorId);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.workflow.version_created",
        permission: "workflows.configure", outcome: "allowed", resourceType: "workflow_version",
        resourceId: version.workflow_version_id }, client);
      return workflowVersion(version);
    });
  }

  async publish(tenantId: string, versionId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<VersionRow>(
        `UPDATE ${schema}.workflow_versions SET status = 'published', published_by_identity = $3, published_at = now()
         WHERE workflow_version_id = $1 AND customer_id = $2 AND status = 'draft'
         RETURNING workflow_version_id, workflow_definition_id, version, status, template_key,
                   template_version, configuration, required_authorization`, [versionId, tenantId, actorId],
      );
      if (!result.rowCount) throw new ConflictException("Workflow version is unavailable or already published.");
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.workflow.published",
        permission: "workflows.publish", outcome: "allowed", resourceType: "workflow_version", resourceId: versionId }, client);
      return workflowVersion(result.rows[0]);
    });
  }

  async pinRun(tenantId: string, actorId: string, input: unknown) {
    const value = PinWorkflowRunSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const version = await client.query<VersionRow>(
        `SELECT workflow_version_id, workflow_definition_id, version, status, template_key,
                template_version, configuration, required_authorization
         FROM ${schema}.workflow_versions WHERE workflow_version_id = $1 AND customer_id = $2 AND status = 'published'`,
        [value.workflowVersionId, tenantId],
      );
      if (!version.rowCount) throw new UnprocessableEntityException("A published tenant workflow version is required.");
      const template = this.template(version.rows[0].template_key);
      await this.assertBinding(client, schema, tenantId, value.capabilityBindingId, template.connectorKey);
      const existing = await client.query<RunRow>(
        `SELECT r.workflow_run_id, r.workflow_version_id, r.capability_binding_id, r.owner_key,
                r.external_run_ref, r.source_session_id, r.last_status, r.last_status_at, v.template_key, b.connector_key
         FROM ${schema}.workflow_run_references r JOIN ${schema}.workflow_versions v ON v.workflow_version_id = r.workflow_version_id
         JOIN ${schema}.capability_bindings b ON b.capability_binding_id = r.capability_binding_id
         WHERE r.customer_id = $1 AND r.owner_key = $2 AND r.external_run_ref = $3 FOR UPDATE`,
        [tenantId, template.ownerKey, value.externalRunRef],
      );
      if (existing.rowCount) {
        const run = existing.rows[0];
        if (run.workflow_version_id !== value.workflowVersionId || run.capability_binding_id !== value.capabilityBindingId) {
          throw new ConflictException("This owner run is already pinned to a different workflow version or binding.");
        }
        if ((run.source_session_id ?? undefined) !== value.sourceSessionId) {
          throw new ConflictException("This owner run is already pinned to a different conversation linkage.");
        }
        return safeRun(run);
      }
      const inserted = await client.query<RunRow>(
        `INSERT INTO ${schema}.workflow_run_references
           (customer_id, workflow_version_id, capability_binding_id, owner_key, external_run_ref, source_session_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING workflow_run_id, workflow_version_id, capability_binding_id, owner_key,
                   external_run_ref, source_session_id, last_status, last_status_at, $7::text AS template_key, $8::text AS connector_key`,
        [tenantId, value.workflowVersionId, value.capabilityBindingId, template.ownerKey, value.externalRunRef,
          value.sourceSessionId ?? null, template.templateKey, template.connectorKey],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.workflow_run.pinned",
        permission: "workflows.configure", outcome: "allowed", resourceType: "workflow_run",
        resourceId: inserted.rows[0].workflow_run_id, metadata: { ownerKey: template.ownerKey } }, client);
      return safeRun(inserted.rows[0]);
    });
  }

  async listRuns(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<RunRow>(
      `SELECT r.workflow_run_id, r.workflow_version_id, r.capability_binding_id, r.owner_key,
              r.external_run_ref, r.source_session_id, r.last_status, r.last_status_at, v.template_key, b.connector_key
       FROM ${schema}.workflow_run_references r JOIN ${schema}.workflow_versions v ON v.workflow_version_id = r.workflow_version_id
       JOIN ${schema}.capability_bindings b ON b.capability_binding_id = r.capability_binding_id
       WHERE r.customer_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [tenantId],
    ));
    return { runs: result.rows.map(safeRun) };
  }

  async status(tenantId: string, runId: string) {
    const run = await this.getRun(tenantId, runId);
    const template = this.template(run.template_key);
    const status = await template.getStatus(run.external_run_ref);
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.workflow_run_references SET last_status = $3, last_status_at = $4
       WHERE workflow_run_id = $1 AND customer_id = $2`, [runId, tenantId, status.status, status.updatedAt],
    ));
    return { ...safeRun({ ...run, last_status: status.status, last_status_at: status.updatedAt }), authoritativeStatus: status };
  }

  async retry(tenantId: string, runId: string, actorId: string, input: unknown) {
    const value = RetryWorkflowRunSchema.parse(input);
    const run = await this.getRun(tenantId, runId);
    const template = this.template(run.template_key);
    if (template.retry.support === "unsupported") {
      throw new UnprocessableEntityException("This workflow owner does not declare a safe idempotent manual retry contract. Reconcile status with the owner instead.");
    }
    const schema = runtimeConfig().schema;
    const command = await this.database.tenantTransaction(tenantId, async (client) => {
      const existing = await client.query<{ workflow_retry_command_id: string; status: string; result: unknown }>(
        `SELECT workflow_retry_command_id, status, result FROM ${schema}.workflow_retry_commands
         WHERE customer_id = $1 AND workflow_run_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [tenantId, runId, value.idempotencyKey],
      );
      if (existing.rowCount) return { ...existing.rows[0], execute: false };
      const inserted = await client.query<{ workflow_retry_command_id: string; status: string; result: unknown }>(
        `INSERT INTO ${schema}.workflow_retry_commands
           (customer_id, workflow_run_id, idempotency_key, requested_by_identity)
         VALUES ($1, $2, $3, $4)
         RETURNING workflow_retry_command_id, status, result`, [tenantId, runId, value.idempotencyKey, actorId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.workflow_run.retry_requested",
        permission: "workflows.retry", outcome: "allowed", resourceType: "workflow_retry_command",
        resourceId: inserted.rows[0].workflow_retry_command_id, metadata: { workflowRunId: runId } }, client);
      return { ...inserted.rows[0], execute: true };
    });
    if (!command.execute) return { workflowRetryCommandId: command.workflow_retry_command_id,
      status: command.status, authoritativeStatus: command.result, duplicate: true };
    try {
      const result = await template.retry.execute(run.external_run_ref, value.idempotencyKey);
      const commandStatus = result.status === "outcome_unknown" ? "outcome_unknown"
        : result.status === "failed" || result.status === "cancelled" ? "failed" : "succeeded";
      await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${schema}.workflow_retry_commands SET status = $3, result = $4::jsonb, completed_at = now()
         WHERE workflow_retry_command_id = $1 AND customer_id = $2 AND status = 'executing'`,
        [command.workflow_retry_command_id, tenantId, commandStatus, JSON.stringify(result)],
      ));
      return { workflowRetryCommandId: command.workflow_retry_command_id, status: commandStatus,
        authoritativeStatus: result, duplicate: false };
    } catch {
      await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${schema}.workflow_retry_commands SET status = 'outcome_unknown', completed_at = now()
         WHERE workflow_retry_command_id = $1 AND customer_id = $2 AND status = 'executing'`,
        [command.workflow_retry_command_id, tenantId],
      ));
      throw new UnprocessableEntityException("The workflow owner did not confirm the retry outcome. The same idempotency key will not be submitted again; reconcile status first.");
    }
  }

  private template(templateKey: string): WorkflowTemplateRegistration {
    const template = this.packs.workflowTemplates().find((candidate) => candidate.templateKey === templateKey);
    if (!template) throw new UnprocessableEntityException("Workflow template is not approved by a compiled business pack.");
    return template;
  }

  private insertVersion(client: PoolClient, schema: string, tenantId: string, definitionId: string, version: number,
    template: WorkflowTemplateRegistration, configuration: Record<string, unknown>, actorId: string) {
    const digest = createHash("sha256").update(JSON.stringify({ key: template.templateKey, version: template.version,
      schema: template.configurationSchema, authorization: template.requiredAuthorization })).digest("hex");
    return client.query<VersionRow>(
      `INSERT INTO ${schema}.workflow_versions
         (workflow_definition_id, customer_id, version, template_key, template_version,
          template_manifest_digest, configuration, required_authorization, created_by_identity)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       RETURNING workflow_version_id, workflow_definition_id, version, status, template_key,
                 template_version, configuration, required_authorization`,
      [definitionId, tenantId, version, template.templateKey, template.version, digest,
        JSON.stringify(configuration), JSON.stringify(template.requiredAuthorization), actorId],
    ).then((result) => result.rows[0]);
  }

  private async assertBinding(client: PoolClient, schema: string, tenantId: string, bindingId: string, connectorKey: string) {
    const result = await client.query(
      `SELECT 1 FROM ${schema}.capability_bindings b
       JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id = b.business_profile_version_id
       JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
       JOIN ${schema}.connector_bindings c ON c.connector_binding_id = b.connector_binding_id
       WHERE b.capability_binding_id = $1 AND p.customer_id = $2 AND b.connector_key = $3
         AND b.capability_key = 'workflow-status' AND b.enabled = true AND c.status = 'active'`,
      [bindingId, tenantId, connectorKey],
    );
    if (!result.rowCount) throw new UnprocessableEntityException("An active tenant workflow-status capability binding is required.");
  }

  private async getRun(tenantId: string, runId: string): Promise<RunRow> {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<RunRow>(
      `SELECT r.workflow_run_id, r.workflow_version_id, r.capability_binding_id, r.owner_key,
              r.external_run_ref, r.source_session_id, r.last_status, r.last_status_at, v.template_key, b.connector_key
       FROM ${schema}.workflow_run_references r JOIN ${schema}.workflow_versions v ON v.workflow_version_id = r.workflow_version_id
       JOIN ${schema}.capability_bindings b ON b.capability_binding_id = r.capability_binding_id
       JOIN ${schema}.connector_bindings c ON c.connector_binding_id = b.connector_binding_id
       WHERE r.workflow_run_id = $1 AND r.customer_id = $2 AND b.enabled = true AND c.status = 'active'`, [runId, tenantId],
    ));
    if (!result.rowCount) throw new NotFoundException("Workflow run not found or its connector is unavailable.");
    return result.rows[0];
  }
}

function workflowVersion(row: VersionRow) {
  return { workflowVersionId: row.workflow_version_id, workflowDefinitionId: row.workflow_definition_id,
    version: row.version, status: row.status, templateKey: row.template_key, templateVersion: row.template_version,
    configuration: row.configuration, requiredAuthorization: row.required_authorization };
}
function safeRun(row: RunRow) {
  return { workflowRunId: row.workflow_run_id, workflowVersionId: row.workflow_version_id,
    capabilityBindingId: row.capability_binding_id, ownerKey: row.owner_key, externalRunRef: row.external_run_ref,
    sourceSessionId: row.source_session_id, status: row.last_status, statusAt: row.last_status_at,
    templateKey: row.template_key, connectorKey: row.connector_key };
}
