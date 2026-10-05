import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../database/database.service.js";
import type { VerifiedBusinessManagerIdentity } from "../../admin/identity/business-manager-identity.bridge.js";
import type { OpenForAustraliaRole } from "./open-for-australia-policy.js";

const PACK_ID = "open-for-australia";

type CustomerRow = {
  customer_id: string;
  external_company_id: string;
};

type EntitlementRow = {
  entitlement_id: string;
  customer_id: string;
  identity_user_id: string;
  role_key: OpenForAustraliaRole;
  authorization_revision: number;
};

export type OpenForAustraliaWorkspacePrincipal = {
  identityUserId: string;
  tenantId: string;
  externalCompanyId: string;
  entitlementId: string;
  role: OpenForAustraliaRole;
  authorizationRevision: number;
};

@Injectable()
export class OpenForAustraliaWorkspaceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async resolvePrincipal(
    identity: VerifiedBusinessManagerIdentity,
    correlationId: string = randomUUID(),
  ): Promise<OpenForAustraliaWorkspacePrincipal> {
    const schema = runtimeSchema();
    const customer = await this.database.query<CustomerRow>(
      `SELECT customer_id, external_company_id
         FROM ${schema}.customers
        WHERE external_company_id = $1 AND status = 'active'
        LIMIT 2`,
      [identity.companyId],
    );
    if (customer.rows.length !== 1) {
      throw new ForbiddenException(
        "An active, unambiguous Open For Australia organisation is required.",
      );
    }

    const tenant = customer.rows[0];
    const entitlement = await this.database.tenantReadTransaction(
      tenant.customer_id,
      (client) => client.query<EntitlementRow>(
        `SELECT entitlement_id, customer_id, identity_user_id, role_key, authorization_revision
           FROM ${schema}.business_pack_entitlements
          WHERE customer_id = $1 AND identity_user_id = $2
            AND pack_id = $3 AND status = 'active'
          LIMIT 2`,
        [tenant.customer_id, identity.userId, PACK_ID],
      ),
    );
    if (entitlement.rows.length !== 1) {
      await this.recordAccess(tenant.customer_id, identity.userId, "denied", correlationId, {
        reason: "entitlement_missing",
      });
      throw new ForbiddenException(
        "Open For Australia workspace entitlement is required.",
      );
    }

    const row = entitlement.rows[0];
    return {
      identityUserId: row.identity_user_id,
      tenantId: row.customer_id,
      externalCompanyId: tenant.external_company_id,
      entitlementId: row.entitlement_id,
      role: row.role_key,
      authorizationRevision: row.authorization_revision,
    };
  }

  async recordAccess(
    tenantId: string,
    identityUserId: string,
    outcome: "allowed" | "denied" | "failed",
    correlationId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const schema = runtimeSchema();
    await this.database.tenantTransaction(tenantId, (client) => this.insertAudit(
      client,
      schema,
      tenantId,
      identityUserId,
      outcome,
      correlationId,
      metadata,
    ));
  }

  private async insertAudit(
    client: PoolClient,
    schema: string,
    tenantId: string,
    identityUserId: string,
    outcome: "allowed" | "denied" | "failed",
    correlationId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${schema}.business_pack_access_audit_events (
         customer_id, identity_user_id, pack_id, event_type,
         outcome, correlation_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        tenantId,
        identityUserId,
        PACK_ID,
        "business_pack.workspace.access",
        outcome,
        correlationId,
        JSON.stringify(metadata),
      ],
    );
  }
}

function runtimeSchema(): string {
  const schema = process.env.SOPHIA_RUNTIME_SCHEMA || "sophia_runtime";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error("SOPHIA_RUNTIME_SCHEMA must be a valid PostgreSQL identifier.");
  }
  return schema;
}
