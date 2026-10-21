import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import pool from '../src/config/db.js';
import { processSyncBatch } from '../src/services/bm.studentUserSync.service.js';
import { createStudentSyncCoordinator } from '../src/workers/student-sync-worker.js';
import { createSharedStudentSyncRuntime } from '../sophia-runtime/dist/operators/shared-student-sync-runtime.js';

if(process.env.XERO_SYNC_EXECUTION_MODE!=='worker' || process.env.STUDENT_USER_SYNC_EXECUTION_MODE!=='worker'
  || process.env.STUDENT_SYNC_PIPELINE_ENABLED!=='true') throw new Error('Shared worker requires both execution modes=worker and STUDENT_SYNC_PIPELINE_ENABLED=true.');
const customerIds=(process.env.STUDENT_SYNC_DOCUMENT_CUSTOMER_IDS || '').split(',').map(value=>value.trim()).filter(Boolean);
const runtime=createSharedStudentSyncRuntime();
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop.abort());
try {
  const coordinator=createStudentSyncCoordinator({runtime,processUsers:processSyncBatch,customerIds,
    log:entry=>console.log(JSON.stringify(entry))});
  const features=await runtime.preflight();
  const ready=await pool.query(`SELECT (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='bm_xero_student_sync_runs' AND column_name IN ('trigger_type','source_connection_id')) AS ready`);
  if(!ready.rows[0]?.ready) throw new Error('Shared worker requires the identity pipeline migration.');
  console.log(JSON.stringify({event:'student_sync_worker_ready',features}));
  while(!stop.signal.aborted) {
    const delay=await coordinator.tick(stop.signal);
    await sleep(delay,undefined,{signal:stop.signal}).catch(error=>{if(error.name!=='AbortError') throw error;});
  }
} finally {await Promise.allSettled([runtime.close(),pool.end()]);}
