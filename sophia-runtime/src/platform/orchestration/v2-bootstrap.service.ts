import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { V2BootstrapRequestSchema, V2BootstrapResponseSchema, type V2BootstrapRequest } from "../contracts/v2/sophia-runtime-v2.contracts.js";

export type RedeemedBootstrap = V2BootstrapRequest & { bootstrapId: string; customerId: string; storeId?: string };

@Injectable()
export class V2BootstrapService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async issue(input: unknown, installationKey?: string) {
    const request = parseRequest(input);
    const config = runtimeConfig();
    const customerId = this.assertCanary(config.defaultCustomerId);
    assertInstallationKey(config.v2InstallationKey, installationKey);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + config.v2BootstrapTtlSeconds * 1000);
    await this.database.tenantTransaction(customerId, async (client) => {
      const device = await client.query<{ store_id: string | null }>(
        `SELECT d.store_id FROM ${config.schema}.devices d
         JOIN ${config.schema}.customers c ON c.customer_id = d.customer_id
         WHERE d.device_id::text = $1 AND d.customer_id = $2
           AND d.status = 'active' AND c.status = 'active'`,
        [request.deviceId, customerId],
      );
      if (!device.rows[0]) throw new ForbiddenException("This device cannot bootstrap Sophia.");
      const profile = await client.query(
        `SELECT 1 FROM ${config.schema}.experience_profiles p
         JOIN ${config.schema}.experience_profile_versions v ON v.experience_profile_version_id = p.active_version_id
         WHERE p.customer_id = $1 AND p.experience_key = $2 AND p.enabled = true AND v.status = 'published'`,
        [customerId, request.experienceId],
      );
      if (profile.rowCount !== 1) throw new ForbiddenException("This Sophia experience is not available.");
      await client.query(
        `INSERT INTO ${config.schema}.runtime_bootstrap_grants
           (customer_id, device_id, experience_key, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [customerId, request.deviceId, request.experienceId, hashToken(token), expiresAt],
      );
    });
    return V2BootstrapResponseSchema.parse({ bootstrapToken: token, expiresAt: expiresAt.toISOString() });
  }

  async redeem(token: string | undefined, requestInput: unknown): Promise<RedeemedBootstrap> {
    if (!token) throw new UnauthorizedException("A bootstrap token is required.");
    const request = parseRequest(requestInput);
    const config = runtimeConfig();
    const customerId = this.assertCanary(config.defaultCustomerId);
    return this.database.tenantTransaction(customerId, async (client) => {
      const result = await client.query<{
        bootstrap_id: string; device_id: string; experience_key: string; status: string;
        expires_at: Date; store_id: string | null;
      }>(
        `SELECT g.bootstrap_id, g.device_id, g.experience_key, g.status, g.expires_at, d.store_id
         FROM ${config.schema}.runtime_bootstrap_grants g
         JOIN ${config.schema}.devices d ON d.device_id::text = g.device_id AND d.customer_id = g.customer_id
         WHERE g.customer_id = $1 AND g.token_hash = $2 FOR UPDATE OF g`,
        [customerId, hashToken(token)],
      );
      const grant = result.rows[0];
      if (!grant || grant.status !== "issued" || new Date(grant.expires_at).getTime() <= Date.now()) {
        if (grant?.status === "issued") await client.query(
          `UPDATE ${config.schema}.runtime_bootstrap_grants SET status = 'expired' WHERE bootstrap_id = $1`,
          [grant.bootstrap_id],
        );
        throw new UnauthorizedException("Bootstrap token is invalid, expired, or already used.");
      }
      if (grant.device_id !== request.deviceId || grant.experience_key !== request.experienceId) {
        throw new UnauthorizedException("Bootstrap token does not match this request.");
      }
      await client.query(
        `UPDATE ${config.schema}.runtime_bootstrap_grants
         SET status = 'redeemed', redeemed_at = now() WHERE bootstrap_id = $1`,
        [grant.bootstrap_id],
      );
      return { ...request, bootstrapId: grant.bootstrap_id, customerId, ...(grant.store_id ? { storeId: grant.store_id } : {}) };
    });
  }

  private assertCanary(customerId?: string): string {
    const config = runtimeConfig();
    if (!customerId || !config.v2CanaryTenantIds.includes(customerId)) {
      throw new ForbiddenException("Sophia Runtime v2 is not enabled for this organisation.");
    }
    return customerId;
  }
}

function parseRequest(input: unknown): V2BootstrapRequest {
  const parsed = V2BootstrapRequestSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException("Invalid Sophia v2 bootstrap request.");
  return parsed.data;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function assertInstallationKey(expected?: string, actual?: string): void {
  if (!expected || expected.length < 32) throw new ForbiddenException("Sophia Runtime v2 bootstrap is not configured.");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual ?? "");
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new UnauthorizedException("Installation authentication failed.");
  }
}
