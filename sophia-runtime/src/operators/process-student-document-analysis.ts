import 'reflect-metadata';
import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { XeroClient } from '../connectors/xero/xero.client.js';
import { XeroCryptoService } from '../connectors/xero/xero-crypto.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { OpenAIDocumentExtractionProvider } from '../business-packs/student-operations/openai-document-extraction.provider.js';
import { StudentDocumentAnalysisWorker } from '../business-packs/student-operations/student-document-analysis.worker.js';
import { runtimeConfig } from '../config/runtime-config.js';

// Explicit tenant allowlist: no elevated cross-tenant table reads. One job per
// tenant per pass provides fairness; one sequential provider call per worker.
const tenants=z.array(z.uuid()).min(1).max(100).parse((process.env.STUDENT_DOCUMENT_ANALYSIS_TENANT_IDS??'').split(',').map(v=>v.trim()).filter(Boolean));
if(process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED!=='true'||!process.env.STUDENT_DOCUMENT_ANALYSIS_MODEL?.trim()||!runtimeConfig().openAi.apiKey)throw new Error('Document analysis worker is not configured.');
if(process.env.XERO_SHARED_QUOTA_ENABLED!=='true'||process.env.XERO_SHARED_BACKOFF_ENABLED!=='true')throw new Error('Document analysis requires shared Xero quota and backoff.');
const db=new DatabaseService();
const xero=new XeroConnectorService(db,new XeroClient(),new XeroCryptoService());
const worker=new StudentDocumentAnalysisWorker(db,xero,new OpenAIDocumentExtractionProvider());
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try{
  do{
    for(const tenant of [...new Set(tenants)]){
      if(stopping)break;
      try{await worker.processOne(tenant);}catch{console.error(JSON.stringify({event:'document_analysis_tick_failed'}));}
    }
    if(process.argv.includes('--once'))break;
    if(!stopping)await delay(5000);
  }while(!stopping);
}finally{await db.onModuleDestroy();}
