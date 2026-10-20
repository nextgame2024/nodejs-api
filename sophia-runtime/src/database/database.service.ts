import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { runtimeConfig } from "../config/runtime-config.js";

export type DatabaseTransactionTimings = Partial<Record<
  "poolAcquireMs" | "setupMs" | "beginMs" | "isolationMs" | "roleMs" |
  "tenantContextMs" | "workMs" | "commitMs" | "rollbackMs" | "totalMs",
  // Pool acquisition includes new-connection handshakes as well as queue waits.
  number
>> & Partial<Record<"poolNewConnection" | "poolTotalBefore" | "poolIdleBefore" | "poolWaitingBefore",
  number
>>;

type TimingObserver = (timings: DatabaseTransactionTimings) => void;

function emitTimings(observer: TimingObserver | undefined, timings: DatabaseTransactionTimings): void {
  if (!observer) return;
  try {
    observer(timings);
  } catch {
    // Diagnostics must never change transaction results or error handling.
  }
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly databaseRole?: string;
  private readonly seenClients = new WeakSet<PoolClient>();

  constructor() {
    const config = runtimeConfig();
    this.databaseRole = config.databaseRole;
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.transaction(client => client.query<T>(text, params));
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    onTiming?: TimingObserver,
  ): Promise<T> {
    const startedAt = performance.now();
    const timings: DatabaseTransactionTimings = {};
    let stageStartedAt = performance.now();
    let client: PoolClient;
    try {
      client = await this.acquireClient(timings);
      timings.poolAcquireMs = performance.now() - stageStartedAt;
    } catch (error) {
      timings.poolAcquireMs = performance.now() - stageStartedAt;
      timings.totalMs = performance.now() - startedAt;
      emitTimings(onTiming, timings);
      throw error;
    }
    try {
      stageStartedAt = performance.now();
      await client.query(this.databaseRole
        ? `BEGIN; SET LOCAL ROLE "${this.databaseRole}"`
        : "BEGIN");
      timings.setupMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      const result = await work(client);
      timings.workMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      await client.query("COMMIT");
      timings.commitMs = performance.now() - stageStartedAt;
      return result;
    } catch (error) {
      stageStartedAt = performance.now();
      await client.query("ROLLBACK");
      timings.rollbackMs = performance.now() - stageStartedAt;
      throw error;
    } finally {
      client.release();
      timings.totalMs = performance.now() - startedAt;
      emitTimings(onTiming, timings);
    }
  }

  async tenantTransaction<T>(
    tenantId: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new Error("A valid tenant UUID is required.");
    }
    return this.transaction(async (client) => {
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenantId]);
      return work(client);
    });
  }

  async tenantReadTransaction<T>(
    tenantId: string,
    work: (client: PoolClient) => Promise<T>,
    onTiming?: TimingObserver,
  ): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new Error("A valid tenant UUID is required.");
    }
    const startedAt = performance.now();
    const timings: DatabaseTransactionTimings = {};
    let stageStartedAt = performance.now();
    let client: PoolClient;
    try {
      client = await this.acquireClient(timings);
      timings.poolAcquireMs = performance.now() - stageStartedAt;
    } catch (error) {
      timings.poolAcquireMs = performance.now() - stageStartedAt;
      timings.totalMs = performance.now() - startedAt;
      emitTimings(onTiming, timings);
      throw error;
    }
    try {
      stageStartedAt = performance.now();
      await client.query([
        "BEGIN",
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        ...(this.databaseRole ? [`SET LOCAL ROLE "${this.databaseRole}"`] : []),
        `SET LOCAL sophia.tenant_id = '${tenantId}'`,
      ].join("; "));
      timings.setupMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      const result = await work(client);
      timings.workMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      await client.query("COMMIT");
      timings.commitMs = performance.now() - stageStartedAt;
      return result;
    } catch (error) {
      stageStartedAt = performance.now();
      await client.query("ROLLBACK");
      timings.rollbackMs = performance.now() - stageStartedAt;
      throw error;
    } finally {
      client.release();
      timings.totalMs = performance.now() - startedAt;
      emitTimings(onTiming, timings);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async acquireClient(timings: DatabaseTransactionTimings): Promise<PoolClient> {
    timings.poolTotalBefore = this.pool.totalCount;
    timings.poolIdleBefore = this.pool.idleCount;
    timings.poolWaitingBefore = this.pool.waitingCount;
    const client = await this.pool.connect();
    timings.poolNewConnection = this.seenClients.has(client) ? 0 : 1;
    this.seenClients.add(client);
    return client;
  }
}
