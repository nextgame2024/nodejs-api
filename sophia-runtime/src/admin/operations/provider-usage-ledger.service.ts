import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";

const identifier = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const dimensions = z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), z.number().finite().nonnegative().max(1e15))
  .refine((value) => Object.keys(value).length <= 32, "At most 32 usage dimensions are allowed.");
const cost = z.object({
  estimatedCostMicrounits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  costTableVersion: z.string().trim().min(1).max(120),
}).strict();
const recordSchema = z.object({
  tenantId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  sourceEventId: z.string().trim().min(1).max(240),
  providerId: identifier,
  adapterKey: identifier,
  measurementStatus: z.enum(["incomplete", "estimated", "measured"]),
  usageDimensions: dimensions,
  cost: cost.optional(),
  occurredAt: z.date().optional(),
}).strict();
const reconcileSchema = z.object({
  expectedRevision: z.number().int().positive(),
  measurementStatus: z.enum(["estimated", "measured"]),
  usageDimensions: dimensions,
  cost: cost.optional(),
}).strict();

type UsageRow = {
  usage_event_id: string; customer_id: string; session_id: string | null; source_event_id: string;
  provider_id: string; adapter_key: string; measurement_status: "incomplete" | "estimated" | "measured";
  usage_dimensions: Record<string, number>; estimated_cost_microunits: string | number | null;
  cost_currency: string | null; cost_table_version: string | null; source_digest: string; revision: number;
  occurred_at: Date | string; recorded_at: Date | string; reconciled_at: Date | string | null;
};

export type ProviderUsageRecord = z.input<typeof recordSchema>;
export type ProviderUsageReconciliation = z.input<typeof reconcileSchema>;

@Injectable()
export class ProviderUsageLedgerService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async record(input: ProviderUsageRecord) {
    const value = recordSchema.parse(input);
    const sourceDigest = digest(value.measurementStatus, value.usageDimensions, value.cost);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(value.tenantId, async (client) => {
      const inserted = await client.query<UsageRow>(
        `INSERT INTO ${schema}.provider_usage_events
           (customer_id, session_id, source_event_id, provider_id, adapter_key, measurement_status,
            usage_dimensions, estimated_cost_microunits, cost_currency, cost_table_version,
            source_digest, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
         ON CONFLICT (customer_id, source_event_id) DO NOTHING
         RETURNING *`,
        [value.tenantId, value.sessionId ?? null, value.sourceEventId, value.providerId, value.adapterKey,
          value.measurementStatus, JSON.stringify(ordered(value.usageDimensions)),
          value.cost?.estimatedCostMicrounits ?? null, value.cost?.currency ?? null,
          value.cost?.costTableVersion ?? null, sourceDigest, value.occurredAt ?? new Date()],
      );
      if (inserted.rowCount) return { ...usageEvent(inserted.rows[0]), replayed: false };
      const existing = await client.query<UsageRow>(
        `SELECT * FROM ${schema}.provider_usage_events
         WHERE customer_id = $1 AND source_event_id = $2`, [value.tenantId, value.sourceEventId],
      );
      const row = existing.rows[0];
      if (!row || row.source_digest !== sourceDigest || row.provider_id !== value.providerId
        || row.adapter_key !== value.adapterKey || row.session_id !== (value.sessionId ?? null)) {
        throw new ConflictException("The usage source event ID was already recorded with different evidence.");
      }
      return { ...usageEvent(row), replayed: true };
    });
  }

  async reconcile(tenantId: string, sourceEventId: string, input: ProviderUsageReconciliation) {
    const value = reconcileSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const current = await client.query<UsageRow>(
        `SELECT * FROM ${schema}.provider_usage_events
         WHERE customer_id = $1 AND source_event_id = $2 FOR UPDATE`, [tenantId, sourceEventId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException("Usage event not found.");
      const sourceDigest = digest(value.measurementStatus, value.usageDimensions, value.cost);
      if (row.source_digest === sourceDigest) return { ...usageEvent(row), replayed: true };
      if (row.revision !== value.expectedRevision || row.measurement_status === "measured"
        || (row.measurement_status === "estimated" && value.measurementStatus === "estimated")) {
        throw new ConflictException("Usage evidence changed or cannot make that reconciliation transition.");
      }
      const updated = await client.query<UsageRow>(
        `UPDATE ${schema}.provider_usage_events
         SET measurement_status = $3, usage_dimensions = $4::jsonb,
             estimated_cost_microunits = $5, cost_currency = $6, cost_table_version = $7,
             source_digest = $8, revision = revision + 1, reconciled_at = now()
         WHERE customer_id = $1 AND source_event_id = $2 AND revision = $9
         RETURNING *`,
        [tenantId, sourceEventId, value.measurementStatus, JSON.stringify(ordered(value.usageDimensions)),
          value.cost?.estimatedCostMicrounits ?? null, value.cost?.currency ?? null,
          value.cost?.costTableVersion ?? null, sourceDigest, value.expectedRevision],
      );
      if (!updated.rowCount) throw new ConflictException("Usage evidence changed during reconciliation.");
      return { ...usageEvent(updated.rows[0]), replayed: false };
    });
  }
}

function usageEvent(row: UsageRow) {
  return {
    usageEventId: row.usage_event_id,
    tenantId: row.customer_id,
    sessionId: row.session_id,
    sourceEventId: row.source_event_id,
    providerId: row.provider_id,
    adapterKey: row.adapter_key,
    measurementStatus: row.measurement_status,
    usageDimensions: row.usage_dimensions,
    costEstimate: row.estimated_cost_microunits === null ? null : {
      estimatedCostMicrounits: Number(row.estimated_cost_microunits),
      currency: row.cost_currency,
      costTableVersion: row.cost_table_version,
      customerCharge: false,
    },
    revision: row.revision,
    occurredAt: new Date(row.occurred_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
    reconciledAt: row.reconciled_at ? new Date(row.reconciled_at).toISOString() : null,
  };
}

function digest(status: string, values: Record<string, number>, valueCost: z.infer<typeof cost> | undefined): string {
  return createHash("sha256").update(JSON.stringify({ status, dimensions: ordered(values), cost: valueCost ?? null })).digest("hex");
}

function ordered(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}
