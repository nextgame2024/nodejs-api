import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import pool from '../src/config/db.js';
import { processSyncBatch } from '../src/services/bm.studentUserSync.service.js';
import { createStudentSyncCoordinator,createDocumentAnalysisCoordinator } from '../src/workers/student-sync-worker.js';
import { createSharedStudentSyncRuntime } from '../sophia-runtime/dist/operators/shared-student-sync-runtime.js';

if(process.env.XERO_SYNC_EXECUTION_MODE!=='worker' || process.env.STUDENT_USER_SYNC_EXECUTION_MODE!=='worker'
  || process.env.STUDENT_SYNC_PIPELINE_ENABLED!=='true') throw new Error('Shared worker requires both execution modes=worker and STUDENT_SYNC_PIPELINE_ENABLED=true.');
const customerIds=(process.env.STUDENT_SYNC_DOCUMENT_CUSTOMER_IDS || '').split(',').map(value=>value.trim()).filter(Boolean);
const runtime=createSharedStudentSyncRuntime();
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop.abort());
let analysisTimer=null,analysisWork=Promise.resolve();
let checklistTimer=null,checklistWork=Promise.resolve();
let catalogueTimer=null,catalogueWork=Promise.resolve();
try {
  const coordinator=createStudentSyncCoordinator({runtime,processUsers:processSyncBatch,customerIds,
    log:entry=>console.log(JSON.stringify(entry))});
  const features=await runtime.preflight();
  const ready=await pool.query(`SELECT (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='bm_xero_student_sync_runs' AND column_name IN ('trigger_type','source_connection_id')) AS ready`);
  if(!ready.rows[0]?.ready) throw new Error('Shared worker requires the identity pipeline migration.');
  console.log(JSON.stringify({event:'student_sync_worker_ready',features,documentPolicy:runtime.documentPolicy()}));
  if(features.STUDENT_DOCUMENT_WORKFLOW_ENABLED){
    const catalogue=createDocumentAnalysisCoordinator({processOne:tenant=>runtime.processSalesCatalogue(tenant),customerIds,
      failureEvent:'student_sales_catalogue_tick_failed',log:entry=>console.log(JSON.stringify(entry))});
    let running=false;
    const tick=()=>{if(running||stop.signal.aborted)return;running=true;catalogueWork=catalogue.tick(stop.signal).finally(()=>{running=false;});};
    tick();catalogueTimer=setInterval(tick,60000);catalogueTimer.unref();
  }
  if(features.STUDENT_DOCUMENT_CHECKLIST_ENABLED){
    const checklist=createDocumentAnalysisCoordinator({processOne:tenant=>runtime.processDocumentChecklist(tenant),customerIds,
      failureEvent:'student_document_checklist_tick_failed',log:entry=>console.log(JSON.stringify(entry))});
    let running=false;
    const tick=()=>{if(running||stop.signal.aborted)return;running=true;checklistWork=checklist.tick(stop.signal).finally(()=>{running=false;});};
    tick();checklistTimer=setInterval(tick,15000);checklistTimer.unref();
  }
  if(features.STUDENT_DOCUMENT_ANALYSIS_ENABLED){
    const analysis=createDocumentAnalysisCoordinator({processOne:tenant=>runtime.processDocumentAnalysis(tenant),customerIds,log:entry=>console.log(JSON.stringify(entry))});
    let running=false;
    const tick=()=>{if(running||stop.signal.aborted)return;running=true;analysisWork=analysis.tick(stop.signal).finally(()=>{running=false;});};
    tick();analysisTimer=setInterval(tick,5000);analysisTimer.unref();
  }
  while(!stop.signal.aborted) {
    const delay=await coordinator.tick(stop.signal);
    await sleep(delay,undefined,{signal:stop.signal}).catch(error=>{if(error.name!=='AbortError') throw error;});
  }
} finally {stop.abort();if(analysisTimer)clearInterval(analysisTimer);if(checklistTimer)clearInterval(checklistTimer);if(catalogueTimer)clearInterval(catalogueTimer);await Promise.allSettled([analysisWork,checklistWork,catalogueWork]);await Promise.allSettled([runtime.close(),pool.end()]);}
