import 'reflect-metadata';
import 'dotenv/config';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { XeroClient } from '../connectors/xero/xero.client.js';
import { XeroCryptoService } from '../connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { TrustDispatchWorker } from '../business-packs/student-operations/trust-dispatch-worker.js';

async function main() {
  const args=z.tuple([z.uuid(),z.uuid()]).safeParse(process.argv.slice(2));
  if (!args.success) throw new Error('Expected customer and TRUST connection UUIDs.');
  const db=new DatabaseService();
  try {
    const xero=new XeroConnectorService(db,new XeroClient(),new XeroCryptoService());
    const worker=new TrustDispatchWorker(db,xero);
    console.log(JSON.stringify(await worker.processOne(...args.data)));
  } finally {await db.onModuleDestroy();}
}
main().catch(()=>{console.error('TRUST dispatch check failed. Verify the customer, connection and worker configuration.');process.exitCode=1;});
