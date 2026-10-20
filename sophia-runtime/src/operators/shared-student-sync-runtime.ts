import 'reflect-metadata';
import { DatabaseService } from '../database/database.service.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { XeroClient } from '../connectors/xero/xero.client.js';
import { XeroCryptoService } from '../connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { StudentOperationsXeroSyncService } from '../business-packs/student-operations/student-operations-xero-sync.service.js';
import { StudentOperationsCasesService } from '../business-packs/student-operations/student-operations-cases.service.js';
import { StudentOperationsCaseDocumentsService } from '../business-packs/student-operations/student-operations-case-documents.service.js';

// No Nest application, HTTP listener, API scheduler or unrelated worker starts.
// The identity side keeps its own connection and authorization in the host.
export function createSharedStudentSyncRuntime() {
  const database=new DatabaseService();
  const xero=new XeroConnectorService(database,new XeroClient(),new XeroCryptoService());
  const invoices=new StudentOperationsXeroSyncService(database,xero);
  const documents=new StudentOperationsCaseDocumentsService(database,new StudentOperationsCasesService(database),xero);
  const schema=runtimeConfig().schema;
  const scopeChecks=new Map<string,{checkedAt:number;ready:boolean}>();
  return {
    async preflight() {
      const result=await database.query<{ready:boolean}>(`SELECT to_regprocedure($1) IS NOT NULL
        AND to_regclass($2) IS NOT NULL AND to_regprocedure($3) IS NOT NULL AS ready`,
        [`${schema}.claim_due_student_operations_xero_worker_runs(integer)`,`${schema}.student_operations_document_daily_budgets`,
          `${schema}.student_operations_document_window(timestamp with time zone)`]);
      if(!result.rows[0]?.ready) throw new Error('Shared sync worker requires Runtime migrations 080 and 081.');
    },
    async processInvoices() {
      const due=await database.query<{customer_id:string;sync_run_id:string}>(
        `SELECT customer_id,sync_run_id FROM ${schema}.claim_due_student_operations_xero_worker_runs(1)`);
      for(const run of due.rows) await invoices.process(run.customer_id,run.sync_run_id);
    },
    async processDocument(customerId:string) {
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
