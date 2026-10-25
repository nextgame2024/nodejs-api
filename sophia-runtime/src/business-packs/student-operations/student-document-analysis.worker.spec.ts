import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { StudentDocumentAnalysisWorker } from './student-document-analysis.worker.js';
import { StudentDocumentAnalysisQueue } from './student-document-analysis.queue.js';
import { OpenAIDocumentExtractionProvider,DocumentExtractionError } from './openai-document-extraction.provider.js';
import { analysisVerdict } from './student-document-analysis.service.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
const extraction={kind:'passport',studentName:'Example Student',evidence:[{page:1,quote:'Expiry date'}],issues:[],expiresOn:'2035-08-06',mrzExpiryMatches:true};
const bytes=Buffer.from('%PDF-example');
const lease={jobId:'job',caseId:'case',documentId:'doc',contentSha256:createHash('sha256').update(bytes).digest('hex'),kind:'passport' as const,schemaVersion:'1',leaseToken:'token',attempts:1};
describe('Document analysis execution',()=>{
  const env={...process.env};
  beforeEach(()=>{process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED='true';process.env.STUDENT_DOCUMENT_ANALYSIS_MODEL='fixture-model';process.env.OPENAI_API_KEY='fixture-key';process.env.SOPHIA_RUNTIME_DATABASE_URL='postgres://example';});
  afterEach(()=>{jest.restoreAllMocks();process.env={...env};});
  function worker(){
    const db={tenantReadTransaction:jest.fn(async(_tenant:unknown,work:any)=>work({query:async()=>({rows:[{mime_type:'application/pdf',size_bytes:bytes.length,xero_connection_id:'connection',source_kind:'Contacts',source_id:'contact',attachment_id:'attachment'}]})}))};
    const xero={attachmentContent:jest.fn(async()=>bytes)};
    const provider={extract:jest.fn(async()=>({extraction,provider:'fixture',model:'fixture',inputTokens:1,outputTokens:1}))};
    const claim=jest.spyOn(StudentDocumentAnalysisQueue.prototype,'claim').mockResolvedValue(lease);
    const complete=jest.spyOn(StudentDocumentAnalysisQueue.prototype,'complete').mockResolvedValue('result');
    const fail=jest.spyOn(StudentDocumentAnalysisQueue.prototype,'fail').mockResolvedValue(true);
    return {run:new StudentDocumentAnalysisWorker(db as unknown as DatabaseService,xero as unknown as XeroConnectorService,provider),xero,provider,claim,complete,fail};
  }
  test('disabled analysis never claims or calls providers',async()=>{
    const w=worker();process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED='false';expect(await w.run.processOne('tenant')).toBe(false);expect(w.claim).not.toHaveBeenCalled();
  });
  test('uses authorized stored location, verifies hash, publishes once',async()=>{
    const w=worker();expect(await w.run.processOne('tenant')).toBe(true);
    expect(w.xero.attachmentContent).toHaveBeenCalledWith('tenant','connection','Contacts','contact','attachment');
    expect(w.provider.extract).toHaveBeenCalledWith(expect.objectContaining({bytes,kind:'passport'}));expect(w.complete).toHaveBeenCalledTimes(1);
  });
  test('changed content is terminal and never reaches extraction',async()=>{
    const w=worker();w.xero.attachmentContent.mockResolvedValue(Buffer.from('changed'));await w.run.processOne('tenant');
    expect(w.provider.extract).not.toHaveBeenCalled();expect(w.fail).toHaveBeenCalledWith('tenant','job','token','source_changed',false);
  });
  test('provider failures persist only safe codes',async()=>{
    const w=worker();w.provider.extract.mockRejectedValue(new DocumentExtractionError('rate_limited',true));await w.run.processOne('tenant');
    expect(w.fail).toHaveBeenCalledWith('tenant','job','token','rate_limited',true);
  });
  test.each(['application/pdf','image/jpeg'] as const)('strict direct %s input with no persistence or tools',async mimeType=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(extraction)}]}],usage:{input_tokens:10,output_tokens:20}})));
    const result=await new OpenAIDocumentExtractionProvider().extract({kind:'passport',bytes,mimeType,schemaVersion:'1',signal:AbortSignal.timeout(1000)});
    expect(result.extraction).toEqual(extraction);const body=JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({store:false,model:'fixture-model',text:{format:{strict:true}}});expect(body.tools).toBeUndefined();
    expect(body.input[0].content[0].type).toBe(mimeType==='application/pdf'?'input_file':'input_image');
  });
  test('refusals and incomplete responses never become accepted results',async()=>{
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'incomplete',output:[]})));
    await expect(new OpenAIDocumentExtractionProvider().extract({kind:'passport',bytes,mimeType:'application/pdf',schemaVersion:'1',signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({code:'invalid_output',retryable:false});
  });
  test('HTTP errors never expose upstream private content',async()=>{
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('private upstream payload',{status:429}));
    await expect(new OpenAIDocumentExtractionProvider().extract({kind:'passport',bytes,mimeType:'application/pdf',schemaVersion:'1',signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({message:'rate_limited',retryable:true});
  });
  test('manual confirmation cannot make an expired passport pass',()=>{
    expect(analysisVerdict({status:'succeeded',extraction:{...extraction,expiresOn:'2020-01-01'},result_id:'r',review_result_id:'r',decision:'confirmed'},'Example Student').status).toBe('invalid');
    expect(analysisVerdict({status:'succeeded',extraction,result_id:'new',review_result_id:'old',decision:'rejected'},'Example Student').status).toBe('passed');
  });
});
