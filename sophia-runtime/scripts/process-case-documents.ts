import 'reflect-metadata';
import 'dotenv/config';
import { DatabaseService } from '../src/database/database.service.js';
import { XeroClient } from '../src/connectors/xero/xero.client.js';
import { XeroCryptoService } from '../src/connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../src/connectors/xero/xero-connector.service.js';
import { StudentOperationsCasesService } from '../src/business-packs/student-operations/student-operations-cases.service.js';
import { StudentOperationsCaseDocumentsService } from '../src/business-packs/student-operations/student-operations-case-documents.service.js';
const args=process.argv.slice(2),tenantId=args[args.indexOf('--customer-id')+1];
if(!args.includes('--customer-id') || !/^[0-9a-f-]{36}$/i.test(tenantId || '')) throw new Error('Usage: process-case-documents.ts --customer-id UUID');
const db=new DatabaseService();
const service=new StudentOperationsCaseDocumentsService(db,new StudentOperationsCasesService(db),new XeroConnectorService(db,new XeroClient(),new XeroCryptoService()));
try {
  let processed=0;
  while(processed<25 && await service.processOne(tenantId)) {
    processed++;
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  console.log(JSON.stringify({processed}));
} finally {await db.onModuleDestroy();}
