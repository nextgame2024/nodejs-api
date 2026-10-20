import 'reflect-metadata';
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseService } from '../database/database.service.js';
import { XeroClient } from '../connectors/xero/xero.client.js';
import { XeroCryptoService } from '../connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { StudentOperationsXeroSyncService } from '../business-packs/student-operations/student-operations-xero-sync.service.js';
import { StudentOperationsXeroSyncScheduler } from '../business-packs/student-operations/student-operations-xero-sync.scheduler.js';
import { runtimeConfig } from '../config/runtime-config.js';

// A separate process/pool: manual requests enqueue immediately; automatic jobs
// are claimed only overnight. Graceful termination finishes the current leased
// import; a forced restart is recovered through the existing expiring lease.
if (process.env.XERO_SYNC_EXECUTION_MODE !== 'worker') throw new Error('XERO_SYNC_EXECUTION_MODE=worker is required.');
const database = new DatabaseService();
const xero = new XeroConnectorService(database,new XeroClient(),new XeroCryptoService());
const scheduler = new StudentOperationsXeroSyncScheduler(database,new StudentOperationsXeroSyncService(database,xero));
const stop = new AbortController();
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>stop.abort());
try {
  const ready=await database.query<{ready:boolean}>(`SELECT to_regprocedure($1) IS NOT NULL AS ready`,
    [`${runtimeConfig().schema}.claim_due_student_operations_xero_worker_runs(integer)`]);
  if (!ready.rows[0]?.ready) throw new Error('Student invoice worker requires Runtime migration 080.');
  while (!stop.signal.aborted) {
    await scheduler.tick();
    await sleep(15_000,undefined,{signal:stop.signal}).catch(error=>{ if (error.name!=='AbortError') throw error; });
  }
} finally { await database.onModuleDestroy(); }
