import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import pool from '../src/config/db.js';
import { processSyncBatch } from '../src/services/bm.studentUserSync.service.js';

// Separate identity-side worker: do not start the HTTP server or unrelated
// inspection/email workers. Uses the existing identity database credentials.
if (process.env.STUDENT_USER_SYNC_EXECUTION_MODE !== 'worker') throw new Error('STUDENT_USER_SYNC_EXECUTION_MODE=worker is required.');
const stop = new AbortController();
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop.abort());
let lastScheduled=0;
try {
  const ready=await pool.query(`SELECT to_regclass('sophia_runtime.student_operations_sync_checkpoints') IS NOT NULL
    AND to_regprocedure('sophia_runtime.student_operations_automatic_window(timestamp with time zone)') IS NOT NULL
    AND (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='bm_xero_student_sync_runs' AND column_name IN ('trigger_type','source_connection_id')) AS ready`);
  if(!ready.rows[0]?.ready || process.env.STUDENT_SYNC_PIPELINE_ENABLED!=='true') {
    throw new Error('Student identity worker requires both pipeline migrations and STUDENT_SYNC_PIPELINE_ENABLED=true.');
  }
  while (!stop.signal.aborted) {
    try {
      const schedule=Date.now()-lastScheduled>=60_000;
      await processSyncBatch({schedule,throwOnError:true});
      if (schedule) lastScheduled=Date.now();
    } catch (error) { console.error(JSON.stringify({event:'student_user_worker_retry',code:error.code || 'internal'})); }
    await sleep(15_000,undefined,{signal:stop.signal}).catch(error=>{if(error.name!=='AbortError') throw error;});
  }
} finally { await pool.end(); }
