import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { AdminPermission } from "../permissions/admin-permissions.js";
import type { PoolClient } from "pg";

@Injectable()
export class AdminAuditService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async record(input: {
    tenantId?: string;
    identityUserId?: string;
    eventType: string;
    permission?: AdminPermission;
    outcome: "allowed" | "denied" | "failed";
    correlationId?: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }, client?: PoolClient): Promise<void> {
    const metadata = sanitizeAuditMetadata(input.metadata ?? {});
    const schema = runtimeConfig().schema;
    const write = (target: { query(text: string, params?: unknown[]): Promise<unknown> }) => target.query(
      `INSERT INTO ${schema}.admin_audit_events (
         customer_id, identity_user_id, event_type, permission_key,
         outcome, correlation_id, resource_type, resource_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        input.tenantId ?? null,
        input.identityUserId ?? null,
        input.eventType,
        input.permission ?? null,
        input.outcome,
        input.correlationId ?? randomUUID(),
        input.resourceType ?? null,
        input.resourceId ?? null,
        JSON.stringify(metadata),
      ],
    );
    if (client) { await write(client); return; }
    if (input.tenantId) { await this.database.tenantTransaction(input.tenantId, write); return; }
    await write(this.database);
  }
}

export function sanitizeAuditMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return sanitize(value, 0) as Record<string, unknown>;
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitize(entry, depth + 1));
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, entry]) => {
    if (/(?:token|secret|password|authorization|credential|audio|transcript|content|prompt|email|phone)/i.test(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, sanitize(entry, depth + 1)];
  }));
}
