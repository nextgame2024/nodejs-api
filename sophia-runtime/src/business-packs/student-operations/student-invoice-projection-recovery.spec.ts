import {afterEach,describe,expect,it,jest} from '@jest/globals';
import type {DatabaseService} from '../../database/database.service.js';
import type {XeroConnectorService} from '../../connectors/xero/xero-connector.service.js';
import {StudentInvoiceProjectionRecovery} from './student-invoice-projection-recovery.js';

const original=process.env.STUDENT_DOCUMENT_CHECKLIST_ENABLED;
afterEach(()=>{if(original===undefined)delete process.env.STUDENT_DOCUMENT_CHECKLIST_ENABLED;else process.env.STUDENT_DOCUMENT_CHECKLIST_ENABLED=original;jest.restoreAllMocks();});
describe('durable invoice indexing recovery',()=>{
  it('does nothing when disabled, without querying or calling Xero',async()=>{
    delete process.env.STUDENT_DOCUMENT_CHECKLIST_ENABLED;
    const transaction=jest.fn(),invoiceById=jest.fn();
    const recovery=new StudentInvoiceProjectionRecovery({tenantTransaction:transaction} as unknown as DatabaseService,{invoiceById} as unknown as XeroConnectorService);
    expect(await recovery.processBatch('tenant')).toBe(false);expect(transaction).not.toHaveBeenCalled();expect(invoiceById).not.toHaveBeenCalled();
  });
  it('bounds retries, redacts failures, and never sends an invoice creation',async()=>{
    process.env.STUDENT_DOCUMENT_CHECKLIST_ENABLED='true';let claimed=false;
    const row={case_id:'case',batch_id:'batch',sequence:1,projection_attempts:7,xero_invoice_id:'invoice',xero_connection_id:'connection',xero_contact_id:'contact'};
    const query=jest.fn(async(sql:string)=>{
      if(sql.includes('SELECT e.*')){if(claimed)return {rows:[],rowCount:0};claimed=true;return {rows:[row],rowCount:1};}
      if(sql.includes('RETURNING projection_attempts'))return {rows:[{projection_attempts:8}],rowCount:1};
      return {rows:[],rowCount:0};
    });
    const transaction=async(_tenant:string,work:(db:unknown)=>Promise<unknown>)=>work({query});
    const invoiceById=jest.fn(async()=>{throw new Error('private provider details');}),createInvoice=jest.fn();
    const recovery=new StudentInvoiceProjectionRecovery({tenantTransaction:transaction,tenantReadTransaction:transaction} as unknown as DatabaseService,{invoiceById,createInvoice} as unknown as XeroConnectorService);
    expect(await recovery.processBatch('tenant')).toBe(true);expect(invoiceById).toHaveBeenCalledTimes(1);expect(createInvoice).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql])=>sql.includes('projection_attempts<8'))).toBe(true);
    expect(query.mock.calls.some(([sql])=>sql.includes('CASE WHEN projection_attempts>=8 THEN NULL'))).toBe(true);
    expect(query.mock.calls.some(([sql])=>sql.includes('SET invoice_dirty=true'))).toBe(true);
    expect(await recovery.processBatch('tenant')).toBe(false);
  });
});
