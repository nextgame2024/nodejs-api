import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { runtimeConfig } from "../config/runtime-config.js";

export type DatabaseTransactionTimings = Partial<Record<
  "poolAcquireMs" | "beginMs" | "isolationMs" | "roleMs" |
  "tenantContextMs" | "workMs" | "commitMs" | "rollbackMs" | "totalMs",
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

  constructor() {
    const config = runtimeConfig();
    this.databaseRole = config.databaseRole;
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assumeRuntimeRole(client);
      const result = await client.query<T>(text, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      client = await this.pool.connect();
      timings.poolAcquireMs = performance.now() - stageStartedAt;
    } catch (error) {
      timings.poolAcquireMs = performance.now() - stageStartedAt;
      timings.totalMs = performance.now() - startedAt;
      emitTimings(onTiming, timings);
      throw error;
    }
    try {
      stageStartedAt = performance.now();
      await client.query("BEGIN");
      timings.beginMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      await this.assumeRuntimeRole(client);
      timings.roleMs = performance.now() - stageStartedAt;
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
      client = await this.pool.connect();
      timings.poolAcquireMs = performance.now() - stageStartedAt;
    } catch (error) {
      timings.poolAcquireMs = performance.now() - stageStartedAt;
      timings.totalMs = performance.now() - startedAt;
      emitTimings(onTiming, timings);
      throw error;
    }
    try {
      stageStartedAt = performance.now();
      await client.query("BEGIN");
      timings.beginMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      timings.isolationMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      await this.assumeRuntimeRole(client);
      timings.roleMs = performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenantId]);
      timings.tenantContextMs = performance.now() - stageStartedAt;
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

  private async assumeRuntimeRole(client: PoolClient): Promise<void> {
    if (this.databaseRole) await client.query(`SET LOCAL ROLE "${this.databaseRole}"`);
  }
}
