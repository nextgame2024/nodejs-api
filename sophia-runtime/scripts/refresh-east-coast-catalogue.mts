import 'reflect-metadata';
import 'dotenv/config';
import {DatabaseService} from '../src/database/database.service.js';
import {xeroConfiguration} from '../src/connectors/xero/xero.config.js';
import {XeroClient} from '../src/connectors/xero/xero.client.js';
import {XeroCryptoService} from '../src/connectors/xero/xero-crypto.service.js';
import {XeroConnectorService} from '../src/connectors/xero/xero-connector.service.js';
import {StudentXeroSalesCatalogueSync} from '../src/business-packs/student-operations/student-xero-sales-catalogue.js';
if(!process.argv.includes('--run'))throw new Error('Pass --run in the configured Xero worker environment to refresh the catalogue.');
if(!xeroConfiguration())throw new Error('The configured Xero worker environment is required.');
process.env.SOPHIA_RUNTIME_DATABASE_URL??=process.env.DATABASE_URL;
process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED='true';
const tenant='33ed40a6-7f2b-407c-aab2-de76b1cb45a8',db=new DatabaseService();
try{
 await db.tenantTransaction(tenant,c=>c.query(`UPDATE sophia_runtime.student_xero_sales_catalogues cat SET next_attempt_at=now() FROM sophia_runtime.student_operations_xero_sync_configurations cfg WHERE cat.customer_id=$1 AND cfg.customer_id=cat.customer_id AND cfg.xero_connection_id=cat.xero_connection_id AND cfg.organisation_role='operating' AND cfg.enabled`,[tenant]));
 const worker=new StudentXeroSalesCatalogueSync(db,new XeroConnectorService(db,new XeroClient(),new XeroCryptoService()));
 for(let i=0;i<2;i++)await worker.processOne(tenant);
 console.log(await db.tenantReadTransaction(tenant,async c=>(await c.query(`SELECT revision,last_synced_at,error_code,jsonb_array_length(snapshot->'trackingCategories') AS categories FROM sophia_runtime.student_xero_sales_catalogues WHERE customer_id=$1`,[tenant])).rows));
}finally{await db.onModuleDestroy();}
