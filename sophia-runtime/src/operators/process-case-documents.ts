import 'reflect-metadata';
import 'dotenv/config';
import { DatabaseService } from '../database/database.service.js';
import { XeroClient } from '../connectors/xero/xero.client.js';
import { XeroCryptoService } from '../connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { StudentOperationsCasesService } from '../business-packs/student-operations/student-operations-cases.service.js';
import { StudentOperationsCaseDocumentsService } from '../business-packs/student-operations/student-operations-case-documents.service.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { runDocumentBatch } from './document-batch.js';

const args = process.argv.slice(2);
const customerIdIndex = args.indexOf('--customer-id');
const customerId = customerIdIndex < 0 ? undefined : args[customerIdIndex + 1];
if (!customerId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerId)) {
  throw new Error('Usage: npm run cases:documents -- --customer-id UUID');
}

const db = new DatabaseService();
const xero = new XeroConnectorService(db, new XeroClient(), new XeroCryptoService());
const service = new StudentOperationsCaseDocumentsService(db, new StudentOperationsCasesService(db), xero);
const schema = runtimeConfig().schema;

try {
  const startedAt = new Date();
  // Do not consume queued jobs until the particular Xero organisations that
  // own them have reauthorized the attachment-read scope.
  const pending = await db.tenantReadTransaction(customerId, client => client.query<{ xero_connection_id: string; jobs: number }>(
    `SELECT xero_connection_id, count(*)::int AS jobs FROM ${schema}.student_operations_document_jobs
     WHERE customer_id=$1 AND (status='queued' OR (status='processing' AND lease_expires_at<now()))
     GROUP BY xero_connection_id`, [customerId]));
  if (pending.rows.length) {
    const status = await xero.status(customerId);
    const connections = new Map(status.connections.map(connection => [connection.connectionId, connection]));
    const blocked = pending.rows.filter(row => {
      const connection = connections.get(row.xero_connection_id);
      return !connection || connection.status !== 'active' || connection.missingAttachmentScopes.length > 0;
    });
    if (!status.configured || blocked.length) {
      console.error(JSON.stringify({ outcome: 'blocked', reason: 'xero_attachment_scope_or_connection',
        connections: blocked.map(row => ({ connectionId: row.xero_connection_id, queuedJobs: row.jobs })) }));
      process.exitCode = 2;
    } else {
      const processed = await runDocumentBatch({
        processOne: () => service.processOne(customerId),
        maxSources: 500, maxDurationMs: 30 * 60 * 1000,
      });
      const errors = await db.tenantReadTransaction(customerId, client => client.query<{ error_code: string; jobs: number }>(
        `SELECT error_code, count(*)::int AS jobs FROM ${schema}.student_operations_document_jobs
         WHERE customer_id=$1 AND error_code IS NOT NULL AND updated_at >= $2 GROUP BY error_code`,
        [customerId, startedAt]));
      const remaining = await db.tenantReadTransaction(customerId, client => client.query(
        `SELECT status,count(*)::int AS sources FROM ${schema}.student_operations_document_jobs
         WHERE customer_id=$1 GROUP BY status`, [customerId]));
      console.log(JSON.stringify({ outcome: errors.rows.length ? 'provider_error' : 'batch_finished', processed, remaining: remaining.rows, errors: errors.rows }));
      if (errors.rows.length) process.exitCode = 1;
    }
  } else {
    console.log(JSON.stringify({ outcome: 'idle', processed: 0 }));
  }
} finally {
  await db.onModuleDestroy();
}
