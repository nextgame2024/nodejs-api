import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { StudentOperationsXeroSyncService } from "./student-operations-xero-sync.service.js";

@Injectable()
export class StudentOperationsXeroSyncScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StudentOperationsXeroSyncScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    private readonly sync: StudentOperationsXeroSyncService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.XERO_SYNC_SCHEDULER_ENABLED?.trim().toLowerCase() !== "true") return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const schema = runtimeConfig().schema;
      const due = await this.database.query<{ customer_id: string; sync_run_id: string }>(
        `SELECT customer_id, sync_run_id
           FROM ${schema}.claim_due_student_operations_xero_sync_runs($1)`,
        [10],
      );
      for (const run of due.rows) {
        await this.sync.process(run.customer_id, run.sync_run_id);
      }
    } catch (error) {
      this.logger.error("Scheduled Xero synchronization tick failed.", error instanceof Error ? error.stack : undefined);
    } finally {
      this.running = false;
    }
  }
}
