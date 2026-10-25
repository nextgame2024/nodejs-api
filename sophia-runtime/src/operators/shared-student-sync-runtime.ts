import 'reflect-metadata';
import { DatabaseService } from '../database/database.service.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { XeroClient } from '../connectors/xero/xero.client.js';
import { XeroCryptoService } from '../connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { StudentOperationsXeroSyncService } from '../business-packs/student-operations/student-operations-xero-sync.service.js';
import { StudentOperationsCasesService } from '../business-packs/student-operations/student-operations-cases.service.js';
import { StudentOperationsCaseDocumentsService } from '../business-packs/student-operations/student-operations-case-documents.service.js';
import { StudentDocumentRechecks } from '../business-packs/student-operations/student-document-rechecks.js';
import { StudentSyncHealth } from './student-sync-health.js';
import { studentDocumentFetchBudgetMinutes } from '../business-packs/student-operations/student-document-fetch-budget.js';
import { StudentDocumentAnalysisWorker } from '../business-packs/student-operations/student-document-analysis.worker.js';
import { OpenAIDocumentExtractionProvider } from '../business-packs/student-operations/openai-document-extraction.provider.js';

const featureFlagNames=['XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED',
  'XERO_SHARED_QUOTA_ENABLED','STUDENT_DOCUMENT_RECHECKS_ENABLED','STUDENT_SYNC_HEALTH_LOGS_ENABLED','STUDENT_DOCUMENT_ANALYSIS_ENABLED'] as const;
function featureFlags() {
  // An explicit allowlist of booleans only: never log arbitrary environment
  // values, credentials or connection strings during startup diagnosis.
  return Object.fromEntries(featureFlagNames.map(name=>[name,process.env[name]==='true']));
}
function requireFlags(message:string,names:readonly string[]) {
  const missing=names.filter(name=>process.env[name]!=='true');
  if(missing.length) throw new Error(`${message} Missing or not exactly true: ${missing.join(', ')}. Update this worker's environment and redeploy.`);
}

// No Nest application, HTTP listener, API scheduler or unrelated worker starts.
// The identity side keeps its own connection and authorization in the host.
export function createSharedStudentSyncRuntime() {
  const database=new DatabaseService();
  const xero=new XeroConnectorService(database,new XeroClient(),new XeroCryptoService());
  const invoices=new StudentOperationsXeroSyncService(database,xero);
  const documents=new StudentOperationsCaseDocumentsService(database,new StudentOperationsCasesService(database),xero);
  const schema=runtimeConfig().schema;
  const scopeChecks=new Map<string,{checkedAt:number;ready:boolean}>();
  const rechecks=new StudentDocumentRechecks(database),recheckSchedules=new Map<string,number>();
  const health=new StudentSyncHealth(database);
  const analysis=new StudentDocumentAnalysisWorker(database,xero,new OpenAIDocumentExtractionProvider());
  return {
    async preflight() {
      studentDocumentFetchBudgetMinutes();
      if(process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED==='true') {
        requireFlags('Document analysis requires shared quota and backoff.',['XERO_SHARED_QUOTA_ENABLED','XERO_SHARED_BACKOFF_ENABLED']);
        if(!process.env.STUDENT_DOCUMENT_ANALYSIS_MODEL?.trim()||!runtimeConfig().openAi.apiKey)throw new Error('Document analysis requires an approved model and server OpenAI credentials.');
        const ready=await database.query<{ready:boolean}>(`SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS ready`,[`${schema}.student_document_analysis_jobs`,`${schema}.student_document_reviews`]);
        if(!ready.rows[0]?.ready)throw new Error('Document analysis requires Runtime migration 094.');
      }
      if(process.env.STUDENT_SYNC_HEALTH_LOGS_ENABLED==='true') requireFlags(
        'Sync health logs require quota, backoff and source deduplication.',
        ['XERO_SHARED_QUOTA_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED']);
      // Diagnose configuration before database readiness. Keep strict true
      // semantics and fail closed; never auto-enable a dependent protection.
      if(process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED==='true') requireFlags(
        'Document rechecks require quota, backoff and source deduplication.',
        ['XERO_SHARED_QUOTA_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED']);
      if(process.env.XERO_SHARED_QUOTA_ENABLED==='true') requireFlags(
        'Shared quota requires shared backoff and source deduplication.',
        ['XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED']);
      if(process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED==='true') requireFlags(
        'Source discovery requires shared Xero backoff.',['XERO_SHARED_BACKOFF_ENABLED']);
      const result=await database.query<{ready:boolean}>(`SELECT to_regprocedure($1) IS NOT NULL
        AND to_regclass($2) IS NOT NULL AND to_regprocedure($3) IS NOT NULL AS ready`,
        [`${schema}.claim_due_student_operations_xero_worker_runs(integer)`,`${schema}.student_operations_document_daily_budgets`,
          `${schema}.student_operations_document_window(timestamp with time zone)`]);
      if(!result.rows[0]?.ready) throw new Error('Shared sync worker requires Runtime migrations 080 and 081.');
      if(process.env.XERO_SHARED_BACKOFF_ENABLED==='true') {
        const rateStore=await database.query<{ready:boolean}>('SELECT to_regclass($1) IS NOT NULL AS ready',
          [`${schema}.xero_connection_rate_limits`]);
        if(!rateStore.rows[0]?.ready) throw new Error('Shared Xero backoff requires Runtime migration 082.');
      }
      if(process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED==='true') {
        const sources=await database.query<{ready:boolean}>(`SELECT to_regclass($1) IS NOT NULL AND EXISTS(
          SELECT 1 FROM information_schema.columns WHERE table_schema=$2
            AND table_name='student_operations_document_jobs' AND column_name='refresh_requested_at') AS ready`,
          [`${schema}.student_operations_document_sources`,schema]);
        if(!sources.rows[0]?.ready) throw new Error('Source discovery requires Runtime migration 083.');
      }
      if(process.env.XERO_SHARED_QUOTA_ENABLED==='true') {
        const quota=await database.query<{ready:boolean}>('SELECT to_regclass($1) IS NOT NULL AS ready',
          [`${schema}.xero_quota_admission`]);
        if(!quota.rows[0]?.ready) throw new Error('Shared Xero quota requires Runtime migration 084.');
      }
      if(process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED==='true') {
        const rechecks=await database.query<{ready:boolean}>('SELECT to_regclass($1) IS NOT NULL AS ready',
          [`${schema}.student_document_recheck_budgets`]);
        if(!rechecks.rows[0]?.ready) throw new Error('Document rechecks require Runtime migration 085.');
      }
      return featureFlags();
    },
    documentPolicy:()=>({fetchBudgetMinutes:studentDocumentFetchBudgetMinutes()}),
    reportHealth:(customerId:string)=>health.report(customerId),
    processDocumentAnalysis:(customerId:string)=>analysis.processOne(customerId),
    async processInvoices() {
      const due=await database.query<{customer_id:string;sync_run_id:string}>(
        `SELECT customer_id,sync_run_id FROM ${schema}.claim_due_student_operations_xero_worker_runs(1)`);
      for(const run of due.rows) await invoices.process(run.customer_id,run.sync_run_id);
    },
    async processDocument(customerId:string) {
      if(process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED==='true' && Date.now()-(recheckSchedules.get(customerId)??0)>=60_000) {
        await rechecks.schedule(customerId);recheckSchedules.set(customerId,Date.now());
      }
      const previous=scopeChecks.get(customerId);
      if(!previous || Date.now()-previous.checkedAt>=60_000) {
        const pending=await database.tenantReadTransaction(customerId,db=>db.query<{xero_connection_id:string}>(
          `SELECT DISTINCT xero_connection_id FROM ${schema}.student_operations_document_jobs
           WHERE customer_id=$1 AND (status='queued' OR (status='processing' AND lease_expires_at<now()))`,[customerId]));
        if(!pending.rows.length) {scopeChecks.set(customerId,{checkedAt:Date.now(),ready:false});return false;}
        const status=await xero.status(customerId);
        const ready=status.configured && pending.rows.every(row=>status.connections.some(connection=>
          connection.connectionId===row.xero_connection_id && connection.status==='active' && connection.missingAttachmentScopes.length===0));
        scopeChecks.set(customerId,{checkedAt:Date.now(),ready});
        if(!ready) return false;
      }
      if(!scopeChecks.get(customerId)?.ready) return false;
      return documents.processOne(customerId,{dailyBudget:true});
    },
    close:()=>database.onModuleDestroy(),
  };
}
