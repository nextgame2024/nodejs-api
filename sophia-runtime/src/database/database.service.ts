import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, QueryResult, QueryResultRow } from "pg";
import { runtimeConfig } from "../config/runtime-config.js";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const config = runtimeConfig();
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
