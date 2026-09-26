import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { ScopedConnectorCredentialService } from "./scoped-connector-credential.service.js";

type BindingRow = {
  connector_binding_id: string;
  customer_id: string;
  external_account_id: string;
  allowed_scopes: unknown;
  status: string;
};

@Injectable()
export class ConnectorAuthorityService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ScopedConnectorCredentialService) private readonly credentials: ScopedConnectorCredentialService,
  ) {}

  async issueCredential(
    tenantId: string,
    connectorBindingId: string,
    requiredScopes: string[],
  ): Promise<{ authorization: string; externalAccountId: string }> {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client: PoolClient) => {
      const result = await client.query<BindingRow>(
        `SELECT connector_binding_id, customer_id, external_account_id,
                allowed_scopes, status
         FROM ${schema}.connector_bindings
         WHERE connector_binding_id = $1 AND customer_id = $2
         LIMIT 1`,
        [connectorBindingId, tenantId],
      );
      const binding = result.rows[0];
      if (!binding) throw new NotFoundException("Connector binding not found.");
      const reconciliationOnly = requiredScopes.length > 0 && requiredScopes.every((scope) =>
        scope.endsWith(":read") || scope.includes(":reconcile"),
      );
      if (binding.status !== "active" && !(binding.status === "disconnecting" && reconciliationOnly)) {
        throw new ForbiddenException("Connector binding is not active for the requested operation.");
      }
      const allowedScopes = Array.isArray(binding.allowed_scopes)
        ? binding.allowed_scopes.filter((scope): scope is string => typeof scope === "string")
        : [];
      const token = this.credentials.issue({
        connectorBindingId: binding.connector_binding_id,
        tenantId: binding.customer_id,
        externalCompanyId: binding.external_account_id,
        allowedScopes,
      }, requiredScopes);
      return { authorization: `Bearer ${token}`, externalAccountId: binding.external_account_id };
    });
  }
}
