import 'reflect-metadata';
import 'dotenv/config';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { XeroClient } from '../connectors/xero/xero.client.js';
import { XeroCryptoService } from '../connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { TrustPaymentSubmission } from '../business-packs/student-operations/trust-payment-submission.js';

async function main() {
  const args=z.tuple([z.enum(['submit','recover']),z.uuid(),z.uuid(),z.uuid()]).safeParse(process.argv.slice(2));
  if (!args.success) throw new Error('Expected action, customer, connection and dispatch IDs.');
  const db=new DatabaseService();
  try {
    const xero=new XeroConnectorService(db,new XeroClient(),new XeroCryptoService());
    const worker=new TrustPaymentSubmission(db,xero);
    const [action,tenant,connection,dispatch]=args.data;
    console.log(JSON.stringify(await worker.run(tenant,connection,dispatch,action)));
  } finally {await db.onModuleDestroy();}
}
main().catch(()=>{console.error('TRUST payment operation could not be confirmed. Check the dispatch register and use recovery for a started submission.');process.exitCode=1;});
