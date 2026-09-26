import { Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { V2SessionPlanResolver } from "./v2-session-plan.resolver.js";

@Injectable()
export class V2ReadinessService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(V2SessionPlanResolver) private readonly plans: V2SessionPlanResolver,
  ) {}

  async check() {
    const config = runtimeConfig();
    const customerId = config.defaultCustomerId;
    if (!customerId || !config.v2CanaryTenantIds.includes(customerId)) {
      return { status: "disabled", checks: [{ check: "canary", status: "disabled", reason: "TENANT_NOT_ENABLED" }] };
    }
    const checks: Array<{ check: string; status: string; reason?: string }> = [];
    checks.push(config.v2InstallationKey && config.v2InstallationKey.length >= 32
      ? { check: "installation_auth", status: "ready" }
      : { check: "installation_auth", status: "not_ready", reason: "INSTALLATION_KEY_MISSING" });
    try {
      const result = await this.database.tenantTransaction(customerId, (client) => client.query<{ experience_key: string }>(
        `SELECT p.experience_key FROM ${config.schema}.experience_profiles p
         JOIN ${config.schema}.experience_profile_versions v ON v.experience_profile_version_id = p.active_version_id
         WHERE p.customer_id = $1 AND p.enabled = true AND v.status = 'published'`, [customerId],
      ));
      if (!result.rowCount) {
        checks.push({ check: "published_profiles", status: "not_ready", reason: "NO_PUBLISHED_PROFILE" });
      } else {
        const resolved = await Promise.allSettled(result.rows.map(({ experience_key }) =>
          this.plans.resolve(customerId, experience_key),
        ));
        checks.push(resolved.every(({ status }) => status === "fulfilled")
          ? { check: "published_compositions", status: "ready" }
          : { check: "published_compositions", status: "not_ready", reason: "UNSUPPORTED_COMPOSITION" });
      }
    } catch {
      checks.push({ check: "database", status: "not_ready", reason: "DATABASE_UNAVAILABLE" });
    }
    return { status: checks.every((check) => check.status === "ready") ? "ready" : "not_ready", checks };
  }
}
