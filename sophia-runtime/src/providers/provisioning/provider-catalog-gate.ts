import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";

@Injectable()
export class ProviderCatalogGate {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async assertTavusReady(customerId: string): Promise<{ deploymentId: string; catalogVersion: string; catalogDigest: string }> {
    const config = runtimeConfig();
    if (!config.tavus.personaId) {
      throw new ServiceUnavailableException("Tavus provisioning is unavailable because no persona is configured.");
    }
    const result = await this.database.tenantTransaction(customerId, (client) => client.query<{
      deployment_id: string; catalog_version: string; catalog_digest: string;
    }>(
      `SELECT deployment_id, catalog_version, catalog_digest
       FROM ${config.schema}.provider_catalog_deployments
       WHERE customer_id = $1 AND environment_key = $2 AND provider_key = 'tavus-full'
         AND provider_resource_id = $3 AND status = 'active'
       LIMIT 1`,
      [customerId, config.deploymentEnvironment, config.tavus.personaId],
    ));
    if (!result.rows[0]) {
      throw new ServiceUnavailableException("The Tavus tool catalog has not been provisioned for this tenant and environment.");
    }
    return { deploymentId: result.rows[0].deployment_id, catalogVersion: result.rows[0].catalog_version,
      catalogDigest: result.rows[0].catalog_digest };
  }
}
