import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { runtimeConfig } from "../config/runtime-config.js";

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

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assumeRuntimeRole(client);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
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
  ): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new Error("A valid tenant UUID is required.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assumeRuntimeRole(client);
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenantId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async assumeRuntimeRole(client: PoolClient): Promise<void> {
    if (this.databaseRole) await client.query(`SET LOCAL ROLE "${this.databaseRole}"`);
  }
}
