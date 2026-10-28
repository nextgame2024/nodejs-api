import type { PoolClient } from 'pg';
import type { XeroContactRecord } from '../../connectors/xero/xero.client.js';
import { caseSchema } from './student-operations-cases.service.js';

// Only actual provider receipts enter the shared sync read model. Never infer
// ACTIVE from a local binding, and never overwrite a newer sync/archive record.
export async function publishXeroContact(db:PoolClient,tenant:string,connection:string,contact:XeroContactRecord) {
  await db.query(`INSERT INTO ${caseSchema()}.student_operations_xero_contacts
    (customer_id,xero_connection_id,xero_contact_id,contact_status,legal_name,email,contact_number,account_number,provider_updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(customer_id,xero_connection_id,xero_contact_id) DO NOTHING`,
    [tenant,connection,contact.contactId,contact.status,contact.legalName,contact.email,contact.contactNumber,contact.accountNumber,contact.updatedAt]);
}
