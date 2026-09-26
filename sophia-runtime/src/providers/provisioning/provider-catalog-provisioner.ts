import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { ToolRegistryService } from "../../tools/tools.service.js";
import { ProviderCapabilityRegistry } from "../capability/provider-capability.registry.js";
import type { TavusFullProvider } from "../tavus/tavus-full.provider.js";

type DeploymentRow = {
  deployment_id: string;
  status: string;
  catalog_digest: string;
  resource_ids: { toolIds?: Record<string, string> };
  operation_lease_until: Date | null;
};

@Injectable()
export class ProviderCatalogProvisioner {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ToolRegistryService) private readonly tools: ToolRegistryService,
    @Inject(ProviderCapabilityRegistry) private readonly providers: ProviderCapabilityRegistry,
  ) {}

  async provisionTavus(customerId: string, catalogVersion: string) {
    if (!validUuid(customerId)) throw new Error("A valid SOPHIA_PROVISION_CUSTOMER_ID is required.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(catalogVersion)) {
      throw new Error("A stable provider catalog version is required.");
    }
    const config = runtimeConfig();
    const personaId = config.tavus.personaId;
    if (!personaId) throw new Error("TAVUS_PERSONA_ID is required for Tavus catalog provisioning.");
    const definitions = this.tools.listDefinitionsForMode(config.providerCatalogMode)
      .filter(({ name }) => name !== "researchBusiness" && name !== "research.public");
    const digest = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
    const schema = config.schema;

    const prepared = await this.database.tenantTransaction(customerId, async (client) => {
      const existing = await client.query<DeploymentRow>(
        `SELECT deployment_id, status, catalog_digest, resource_ids, operation_lease_until
         FROM ${schema}.provider_catalog_deployments
         WHERE customer_id = $1 AND environment_key = $2 AND provider_key = 'tavus-full'
           AND catalog_version = $3`,
        [customerId, config.deploymentEnvironment, catalogVersion],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].status === "active" && existing.rows[0].catalog_digest === digest) {
          return { deployment: existing.rows[0], alreadyActive: true };
        }
        const reusable = existing.rows[0].catalog_digest === digest && (
          existing.rows[0].status === "failed"
          || (existing.rows[0].status === "provisioning"
              && new Date(existing.rows[0].operation_lease_until ?? 0).getTime() <= Date.now())
        );
        if (!reusable) throw new ConflictException("This catalog version already exists and is not reusable.");
        const resumed = await client.query<DeploymentRow>(
          `UPDATE ${schema}.provider_catalog_deployments
           SET status = 'provisioning', operation_lease_until = now() + interval '15 minutes',
               last_error = NULL, updated_at = now()
           WHERE deployment_id = $1 AND customer_id = $2
           RETURNING deployment_id, status, catalog_digest, resource_ids, operation_lease_until`,
          [existing.rows[0].deployment_id, customerId],
        );
        return { deployment: resumed.rows[0], alreadyActive: false };
      }

      await client.query(
        `INSERT INTO ${schema}.provider_resource_owners (
           environment_key, provider_key, provider_resource_id, customer_id
         ) VALUES ($1, 'tavus-full', $2, $3)
         ON CONFLICT DO NOTHING`,
        [config.deploymentEnvironment, personaId, customerId],
      );
      const ownership = await client.query(
        `SELECT 1 FROM ${schema}.provider_resource_owners
         WHERE environment_key = $1 AND provider_key = 'tavus-full'
           AND provider_resource_id = $2 AND customer_id = $3`,
        [config.deploymentEnvironment, personaId, customerId],
      );
      if (ownership.rowCount !== 1) {
        throw new ConflictException("The configured provider resource belongs to another tenant in this environment.");
      }
      const inserted = await client.query<DeploymentRow>(
        `INSERT INTO ${schema}.provider_catalog_deployments (
           customer_id, environment_key, provider_key, catalog_version,
           catalog_digest, provider_resource_id, resource_ids, operation_lease_until
         ) VALUES ($1, $2, 'tavus-full', $3, $4, $5, '{"toolIds":{}}'::jsonb,
                   now() + interval '15 minutes')
         RETURNING deployment_id, status, catalog_digest, resource_ids, operation_lease_until`,
        [customerId, config.deploymentEnvironment, catalogVersion, digest, personaId],
      );
      return { deployment: inserted.rows[0], alreadyActive: false };
    });
    if (prepared.alreadyActive) return { ...prepared.deployment, catalogVersion, alreadyActive: true };

    const provider = this.providers.resolve<TavusFullProvider>(
      "composite-realtime-v1", "native-realtime",
    ).implementation;
    try {
      const provisioned = await provider.provisionCatalog({
        personaId,
        definitions,
        existingToolIds: prepared.deployment.resource_ids.toolIds ?? {},
        onToolAllocated: (name, id) => this.recordTool(customerId, prepared.deployment.deployment_id, name, id),
      });
      await this.database.tenantTransaction(customerId, async (client) => {
        await client.query(
          `UPDATE ${schema}.provider_catalog_deployments
           SET status = 'retired', updated_at = now()
           WHERE customer_id = $1 AND environment_key = $2 AND provider_key = 'tavus-full'
             AND status = 'active' AND deployment_id <> $3`,
          [customerId, config.deploymentEnvironment, prepared.deployment.deployment_id],
        );
        await client.query(
          `UPDATE ${schema}.provider_catalog_deployments
           SET status = 'active', resource_ids = $1::jsonb, operation_lease_until = NULL,
               activated_at = now(), updated_at = now()
           WHERE deployment_id = $2 AND customer_id = $3`,
          [JSON.stringify({ toolIds: provisioned.toolIds, internetSearchEnabled: provisioned.internetSearchEnabled,
            catalogMode: config.providerCatalogMode }), prepared.deployment.deployment_id, customerId],
        );
      });
      return { deploymentId: prepared.deployment.deployment_id, catalogVersion, catalogDigest: digest, alreadyActive: false };
    } catch (error) {
      await this.database.tenantTransaction(customerId, (client) => client.query(
        `UPDATE ${schema}.provider_catalog_deployments
         SET status = 'failed', operation_lease_until = NULL, last_error = $1, updated_at = now()
         WHERE deployment_id = $2 AND customer_id = $3`,
        [safeError(error), prepared.deployment.deployment_id, customerId],
      ));
      throw error;
    }
  }

  private async recordTool(customerId: string, deploymentId: string, name: string, id: string): Promise<void> {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(customerId, (client) => client.query(
      `UPDATE ${schema}.provider_catalog_deployments
       SET resource_ids = jsonb_set(resource_ids, ARRAY['toolIds', $1], to_jsonb($2::text), true),
           operation_lease_until = now() + interval '15 minutes', updated_at = now()
       WHERE deployment_id = $3 AND customer_id = $4`,
      [name, id, deploymentId, customerId],
    ));
  }
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Provider catalog provisioning failed").slice(0, 1_000);
}
