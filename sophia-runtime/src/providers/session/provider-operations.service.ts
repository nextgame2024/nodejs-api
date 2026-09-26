import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type {
  ProviderSessionAdapter,
  ProviderSessionOpenRequest,
  ProviderSessionOpenResult,
  StoredProviderSession,
} from "./provider-session.interface.js";
import { ProviderPartialOpenError } from "./provider-session.interface.js";
import { ProviderSessionRegistry } from "./provider-session.registry.js";
import { RuntimeAdmissionService } from "../../platform/admission/runtime-admission.service.js";

export type OperationalSessionRow = QueryResultRow & {
  session_id: string;
  customer_id: string;
  status: string;
  ai_provider: string;
  avatar_provider: string;
  provider_session_id: string | null;
  avatar_session_id: string | null;
  metadata?: Record<string, unknown>;
};

type Allocation = { allocationId: string; customerId: string; adapterKey: string };

@Injectable()
export class ProviderOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProviderSessionRegistry) private readonly sessions: ProviderSessionRegistry,
    @Inject(RuntimeAdmissionService) private readonly admission: RuntimeAdmissionService,
  ) {}

  async begin(customerId: string, adapterKey: string, experience: string): Promise<Allocation> {
    return this.admission.reserveProviderSession(customerId, adapterKey, experience);
  }

  async open(
    allocation: Allocation,
    adapter: ProviderSessionAdapter,
    request: ProviderSessionOpenRequest,
  ): Promise<ProviderSessionOpenResult> {
    const pending = adapter.open(request);
    try {
      const opened = await withTimeout(pending, runtimeConfig().providerOpenTimeoutMs, "Provider session creation timed out.");
      await this.recordOpened(allocation, opened.persistence);
      return opened;
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        await this.markCleanupPending(allocation, error);
        void pending.then(async (opened) => {
          await this.recordOpened(allocation, opened.persistence);
          await this.compensate(allocation, adapter, opened.persistence);
        }).catch((lateError: unknown) => this.markFailed(allocation, lateError)).catch(() => undefined);
      } else if (error instanceof ProviderPartialOpenError) {
        await this.recordSnapshot(allocation, error.recoverableSession);
        await this.markCleanupPending(allocation, error);
      } else {
        await this.markFailed(allocation, error);
      }
      throw new ServiceUnavailableException(safeError(error));
    }
  }

  async attach(allocation: Allocation, sessionId: string): Promise<void> {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(allocation.customerId, (client) => client.query(
      `UPDATE ${schema}.provider_session_allocations
       SET session_id = $1, stage = 'attached', attached_at = now(), updated_at = now()
       WHERE allocation_id = $2 AND customer_id = $3 AND stage = 'allocated'`,
      [sessionId, allocation.allocationId, allocation.customerId],
    ));
  }

  async compensate(
    allocation: Allocation,
    adapter: ProviderSessionAdapter,
    persistence: ProviderSessionOpenResult["persistence"],
  ): Promise<void> {
    try {
      await withTimeout(
        adapter.close(toStored(persistence)),
        runtimeConfig().providerCloseTimeoutMs,
        "Provider cleanup timed out.",
      );
      await this.markReleased(allocation);
    } catch (error) {
      await this.markCleanupPending(allocation, error);
    }
  }

  async close(row: OperationalSessionRow): Promise<OperationalSessionRow> {
    if (row.status === "closed" || row.status === "closing" || row.status === "cleanup_pending") return row;
    const schema = runtimeConfig().schema;
    const claimed = await this.database.tenantTransaction(row.customer_id, (client) => client.query<OperationalSessionRow>(
      `UPDATE ${schema}.sessions SET status = 'closing', updated_at = now()
       WHERE session_id = $1 AND customer_id = $2 AND status = 'active'
       RETURNING *`,
      [row.session_id, row.customer_id],
    ));
    if (!claimed.rows[0]) return row;
    const stored = storedFromRow(claimed.rows[0]);
    try {
      await withTimeout(
        this.sessions.resolveStoredSession(stored).close(stored),
        runtimeConfig().providerCloseTimeoutMs,
        "Provider session close timed out.",
      );
      const completed = await this.database.tenantTransaction(row.customer_id, async (client) => {
        await client.query(
          `UPDATE ${schema}.provider_session_allocations
           SET stage = 'released', released_at = now(), cleanup_lease_owner = NULL,
               cleanup_lease_until = NULL, updated_at = now()
           WHERE session_id = $1 AND customer_id = $2`,
          [row.session_id, row.customer_id],
        );
        return client.query<OperationalSessionRow>(
          `UPDATE ${schema}.sessions
           SET status = 'closed', ended_at = COALESCE(ended_at, now()), updated_at = now()
           WHERE session_id = $1 AND customer_id = $2 RETURNING *`,
          [row.session_id, row.customer_id],
        );
      });
      return completed.rows[0] ?? claimed.rows[0];
    } catch (error) {
      await this.database.tenantTransaction(row.customer_id, async (client) => {
        await client.query(
          `UPDATE ${schema}.sessions SET status = 'cleanup_pending', updated_at = now()
           WHERE session_id = $1 AND customer_id = $2`,
          [row.session_id, row.customer_id],
        );
        await client.query(
          `UPDATE ${schema}.provider_session_allocations
           SET stage = 'cleanup_pending', cleanup_after = now(), cleanup_attempts = cleanup_attempts + 1,
               last_error_code = 'CLOSE_FAILED', last_error_message = $1, updated_at = now()
           WHERE session_id = $2 AND customer_id = $3`,
          [safeError(error), row.session_id, row.customer_id],
        );
      });
      throw new ServiceUnavailableException("Provider cleanup is pending and will be reconciled.");
    }
  }

  async heartbeat(row: OperationalSessionRow): Promise<OperationalSessionRow> {
    const config = runtimeConfig();
    if (row.status !== "active") return row;
    const result = await this.database.tenantTransaction(row.customer_id, (client) => client.query<OperationalSessionRow>(
      `UPDATE ${config.schema}.sessions
       SET last_seen_at = now(),
           disconnect_expires_at = LEAST(hard_expires_at, now() + make_interval(secs => $1)),
           updated_at = now()
       WHERE session_id = $2 AND customer_id = $3 AND status = 'active'
       RETURNING *`,
      [config.disconnectGraceSeconds, row.session_id, row.customer_id],
    ));
    return result.rows[0] ?? row;
  }

  async disconnect(row: OperationalSessionRow): Promise<OperationalSessionRow> {
    if (row.status !== "active") return row;
    const config = runtimeConfig();
    const result = await this.database.tenantTransaction(row.customer_id, (client) => client.query<OperationalSessionRow>(
      `UPDATE ${config.schema}.sessions
       SET disconnect_expires_at = LEAST(hard_expires_at, now() + make_interval(secs => $1)), updated_at = now()
       WHERE session_id = $2 AND customer_id = $3 AND status = 'active' RETURNING *`,
      [config.disconnectGraceSeconds, row.session_id, row.customer_id],
    ));
    return result.rows[0] ?? row;
  }

  async reconcileTenant(customerId: string, limit = 25): Promise<{ claimed: number; released: number; pending: number }> {
    const config = runtimeConfig();
    const workerId = randomUUID();
    const claimed = await this.database.tenantTransaction(customerId, async (client) => {
      await client.query(
        `INSERT INTO ${config.schema}.provider_session_allocations (
           customer_id, session_id, lifecycle_adapter_key, experience_key, stage,
           provider_snapshot, cleanup_after, allocated_at, attached_at
         )
         SELECT s.customer_id, s.session_id,
                COALESCE(s.metadata->>'lifecycleAdapterKey',
                  CASE WHEN s.ai_provider = 'tavus-full'
                    THEN 'composite-realtime-experience-v1' ELSE 'native-realtime-experience-v1' END),
                COALESCE(s.metadata->>'experience', 'legacy'), 'attached',
                jsonb_build_object(
                  'aiProvider', s.ai_provider,
                  'avatarProvider', s.avatar_provider,
                  'providerSessionId', s.provider_session_id,
                  'avatarSessionId', s.avatar_session_id,
                  'metadata', s.metadata
                ),
                COALESCE(s.hard_expires_at, s.started_at + interval '2 hours'), s.started_at, s.started_at
         FROM ${config.schema}.sessions s
         WHERE s.customer_id = $1 AND s.status IN ('active', 'cleanup_pending')
           AND NOT EXISTS (
             SELECT 1 FROM ${config.schema}.provider_session_allocations a
             WHERE a.session_id = s.session_id
           )
         ON CONFLICT (session_id) DO NOTHING`,
        [customerId],
      );
      const candidates = await client.query<{
        allocation_id: string; provider_snapshot: Record<string, unknown>; session_id: string | null;
        ai_provider: string | null; avatar_provider: string | null; provider_session_id: string | null;
        avatar_session_id: string | null; metadata: Record<string, unknown> | null;
      }>(
        `SELECT a.allocation_id, a.provider_snapshot, a.session_id,
                s.ai_provider, s.avatar_provider, s.provider_session_id, s.avatar_session_id, s.metadata
         FROM ${config.schema}.provider_session_allocations a
         LEFT JOIN ${config.schema}.sessions s ON s.session_id = a.session_id
         WHERE a.customer_id = $1
           AND a.stage IN ('allocated', 'attached', 'cleanup_pending', 'cleaning')
           AND (a.cleanup_lease_until IS NULL OR a.cleanup_lease_until < now())
           AND (a.stage IN ('cleanup_pending', 'cleaning') OR a.cleanup_after <= now()
                OR (s.status = 'active' AND (s.disconnect_expires_at <= now() OR s.hard_expires_at <= now())))
         ORDER BY a.cleanup_after, a.created_at
         FOR UPDATE OF a SKIP LOCKED LIMIT $2`,
        [customerId, Math.min(100, Math.max(1, limit))],
      );
      for (const candidate of candidates.rows) {
        await client.query(
          `UPDATE ${config.schema}.provider_session_allocations
           SET stage = 'cleaning', cleanup_lease_owner = $1,
               cleanup_lease_until = now() + interval '2 minutes', updated_at = now()
           WHERE allocation_id = $2`,
          [workerId, candidate.allocation_id],
        );
        if (candidate.session_id) {
          await client.query(
            `UPDATE ${config.schema}.sessions SET status = 'closing', updated_at = now()
             WHERE session_id = $1 AND customer_id = $2 AND status IN ('active', 'cleanup_pending')`,
            [candidate.session_id, customerId],
          );
        }
      }
      return candidates.rows;
    });

    let released = 0;
    let pending = 0;
    for (const candidate of claimed) {
      const stored = snapshot(candidate);
      try {
        await withTimeout(
          this.sessions.resolveStoredSession(stored).close(stored),
          config.providerCloseTimeoutMs,
          "Provider reconciliation close timed out.",
        );
        await this.database.tenantTransaction(customerId, async (client) => {
          await client.query(
            `UPDATE ${config.schema}.provider_session_allocations
             SET stage = 'released', released_at = now(), cleanup_lease_owner = NULL,
                 cleanup_lease_until = NULL, updated_at = now()
             WHERE allocation_id = $1 AND cleanup_lease_owner = $2`,
            [candidate.allocation_id, workerId],
          );
          if (candidate.session_id) await client.query(
            `UPDATE ${config.schema}.sessions
             SET status = 'closed', ended_at = COALESCE(ended_at, now()), updated_at = now()
             WHERE session_id = $1 AND customer_id = $2`,
            [candidate.session_id, customerId],
          );
        });
        released += 1;
      } catch (error) {
        await this.database.tenantTransaction(customerId, (client) => client.query(
          `UPDATE ${config.schema}.provider_session_allocations
           SET stage = 'cleanup_pending', cleanup_attempts = cleanup_attempts + 1,
               cleanup_after = now() + make_interval(secs => LEAST(300, 15 * (cleanup_attempts + 1))),
               cleanup_lease_owner = NULL, cleanup_lease_until = NULL,
               last_error_code = 'RECONCILE_FAILED', last_error_message = $1, updated_at = now()
           WHERE allocation_id = $2 AND cleanup_lease_owner = $3`,
          [safeError(error), candidate.allocation_id, workerId],
        ));
        pending += 1;
      }
    }
    return { claimed: claimed.length, released, pending };
  }

  private async recordOpened(allocation: Allocation, persistence: ProviderSessionOpenResult["persistence"]): Promise<void> {
    return this.recordSnapshot(allocation, toStored(persistence));
  }

  private async recordSnapshot(allocation: Allocation, snapshot: StoredProviderSession): Promise<void> {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(allocation.customerId, (client) => client.query(
      `UPDATE ${schema}.provider_session_allocations
       SET stage = 'allocated', provider_snapshot = $1::jsonb, allocated_at = now(), updated_at = now()
       WHERE allocation_id = $2 AND customer_id = $3 AND stage IN ('allocating', 'cleanup_pending')`,
      [JSON.stringify(snapshot), allocation.allocationId, allocation.customerId],
    ));
  }

  private async markReleased(allocation: Allocation): Promise<void> {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(allocation.customerId, (client) => client.query(
      `UPDATE ${schema}.provider_session_allocations
       SET stage = 'released', released_at = now(), cleanup_lease_owner = NULL,
           cleanup_lease_until = NULL, updated_at = now()
       WHERE allocation_id = $1 AND customer_id = $2`,
      [allocation.allocationId, allocation.customerId],
    ));
  }

  private async markCleanupPending(allocation: Allocation, error: unknown): Promise<void> {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(allocation.customerId, (client) => client.query(
      `UPDATE ${schema}.provider_session_allocations
       SET stage = 'cleanup_pending', cleanup_after = now(), last_error_code = 'CLEANUP_REQUIRED',
           last_error_message = $1, updated_at = now()
       WHERE allocation_id = $2 AND customer_id = $3 AND stage <> 'released'`,
      [safeError(error), allocation.allocationId, allocation.customerId],
    ));
  }

  private async markFailed(allocation: Allocation, error: unknown): Promise<void> {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(allocation.customerId, (client) => client.query(
      `UPDATE ${schema}.provider_session_allocations
       SET stage = 'failed', last_error_code = 'OPEN_FAILED', last_error_message = $1, updated_at = now()
       WHERE allocation_id = $2 AND customer_id = $3 AND stage = 'allocating'`,
      [safeError(error), allocation.allocationId, allocation.customerId],
    ));
  }
}

class OperationTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toStored(input: ProviderSessionOpenResult["persistence"]): StoredProviderSession {
  return {
    aiProvider: input.aiProvider,
    avatarProvider: input.avatarProvider,
    providerSessionId: input.providerSessionId,
    avatarSessionId: input.avatarSessionId,
    metadata: input.metadata,
  };
}

function storedFromRow(row: OperationalSessionRow): StoredProviderSession {
  return {
    aiProvider: row.ai_provider,
    avatarProvider: row.avatar_provider,
    providerSessionId: row.provider_session_id ?? undefined,
    avatarSessionId: row.avatar_session_id ?? undefined,
    metadata: row.metadata ?? {},
  };
}

function snapshot(candidate: {
  provider_snapshot: Record<string, unknown>;
  ai_provider: string | null; avatar_provider: string | null; provider_session_id: string | null;
  avatar_session_id: string | null; metadata: Record<string, unknown> | null;
}): StoredProviderSession {
  const value = candidate.provider_snapshot;
  if (typeof value["aiProvider"] === "string" && typeof value["avatarProvider"] === "string") {
    return value as StoredProviderSession;
  }
  return {
    aiProvider: candidate.ai_provider ?? "unknown",
    avatarProvider: candidate.avatar_provider ?? "none",
    providerSessionId: candidate.provider_session_id ?? undefined,
    avatarSessionId: candidate.avatar_session_id ?? undefined,
    metadata: candidate.metadata ?? {},
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Provider operation failed").slice(0, 1_000);
}
