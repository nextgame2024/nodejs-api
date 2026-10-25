import {jest} from '@jest/globals';

const query=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const tenantRead=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const close=jest.fn(async()=>{});
const processInvoices=jest.fn(async(..._args:unknown[])=>{});
const processOne=jest.fn(async(..._args:unknown[])=>true);
const status=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const scheduleRechecks=jest.fn(async(_customer:string)=>0);
const processAnalysis=jest.fn(async(_customer:string)=>true);
jest.unstable_mockModule('../business-packs/student-operations/student-document-analysis.worker.js',()=>({StudentDocumentAnalysisWorker:class {processOne=processAnalysis;}}));
jest.unstable_mockModule('../business-packs/student-operations/openai-document-extraction.provider.js',()=>({OpenAIDocumentExtractionProvider:class {}}));
jest.unstable_mockModule('../business-packs/student-operations/student-document-rechecks.js',()=>({StudentDocumentRechecks:class {schedule=scheduleRechecks;}}));
jest.unstable_mockModule('../database/database.service.js',()=>({DatabaseService:class {
  query=query;tenantReadTransaction=tenantRead;onModuleDestroy=close;
}}));
jest.unstable_mockModule('../connectors/xero/xero-connector.service.js',()=>({XeroConnectorService:class {status=status;}}));
jest.unstable_mockModule('../business-packs/student-operations/student-operations-xero-sync.service.js',()=>({StudentOperationsXeroSyncService:class {process=processInvoices;}}));
jest.unstable_mockModule('../business-packs/student-operations/student-operations-cases.service.js',()=>({StudentOperationsCasesService:class {}}));
jest.unstable_mockModule('../business-packs/student-operations/student-operations-case-documents.service.js',()=>({StudentOperationsCaseDocumentsService:class {processOne=processOne;}}));
const {createSharedStudentSyncRuntime}=await import('./shared-student-sync-runtime.js');
const oldUrl=process.env.SOPHIA_RUNTIME_DATABASE_URL;
beforeAll(()=>{process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';});
afterAll(()=>{if(oldUrl===undefined) delete process.env.SOPHIA_RUNTIME_DATABASE_URL;else process.env.SOPHIA_RUNTIME_DATABASE_URL=oldUrl;});
beforeEach(()=>{jest.clearAllMocks();query.mockReset();tenantRead.mockReset();status.mockReset();});
describe('Shared worker Runtime adapter',()=>{
  it('validates analysis configuration before activation and delegates its independent lane',async()=>{
    const keys=['STUDENT_DOCUMENT_ANALYSIS_ENABLED','STUDENT_DOCUMENT_ANALYSIS_MODEL','OPENAI_API_KEY','XERO_SHARED_QUOTA_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED'];
    const previous=keys.map(k=>process.env[k]);
    try{
      process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED='true';delete process.env.XERO_SHARED_QUOTA_ENABLED;
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('Document analysis requires shared quota');
      process.env.XERO_SHARED_QUOTA_ENABLED=process.env.XERO_SHARED_BACKOFF_ENABLED=process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED='true';delete process.env.STUDENT_DOCUMENT_ANALYSIS_MODEL;
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('approved model');
      process.env.STUDENT_DOCUMENT_ANALYSIS_MODEL='fixture';process.env.OPENAI_API_KEY='fixture';query.mockResolvedValue({rows:[{ready:true}]});
      const worker=createSharedStudentSyncRuntime();expect((await worker.preflight()).STUDENT_DOCUMENT_ANALYSIS_ENABLED).toBe(true);
      await worker.processDocumentAnalysis('tenant');expect(processAnalysis).toHaveBeenCalledWith('tenant');
    }finally{keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});}
  });
  it('gates offer analysis on document analysis and migration 096',async()=>{
    const keys=['STUDENT_OFFER_ANALYSIS_ENABLED','STUDENT_DOCUMENT_ANALYSIS_ENABLED'],previous=keys.map(k=>process.env[k]);
    try{process.env.STUDENT_OFFER_ANALYSIS_ENABLED='true';delete process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED;
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('Offer analysis requires document analysis');
      process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED='true';query.mockResolvedValue({rows:[{ready:false}]});
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('096');
    }finally{keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});}
  });
  it('validates the opt-in budget before database access and exposes only the numeric policy',async()=>{
    const keys=['STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES','XERO_SHARED_QUOTA_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED'];
    const previous=keys.map(key=>process.env[key]);
    try {
      process.env.STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES='121';
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('30 to 120');
      process.env.STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES='120';delete process.env.XERO_SHARED_QUOTA_ENABLED;
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('XERO_SHARED_QUOTA_ENABLED');
      expect(query).not.toHaveBeenCalled();
      keys.slice(1).forEach(key=>process.env[key]='true');query.mockResolvedValue({rows:[{ready:true}]});
      const worker=createSharedStudentSyncRuntime();await worker.preflight();
      expect(worker.documentPolicy()).toEqual({fetchBudgetMinutes:120});
    } finally {keys.forEach((key,index)=>{if(previous[index]===undefined) delete process.env[key];else process.env[key]=previous[index];});}
  });
  it('requires protected source processing before enabling health logs',async()=>{
    const keys=['STUDENT_SYNC_HEALTH_LOGS_ENABLED','XERO_SHARED_QUOTA_ENABLED'];const previous=keys.map(key=>process.env[key]);
    process.env.STUDENT_SYNC_HEALTH_LOGS_ENABLED='true';delete process.env.XERO_SHARED_QUOTA_ENABLED;
    try {
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('XERO_SHARED_QUOTA_ENABLED');
      expect(query).not.toHaveBeenCalled();
    } finally {keys.forEach((key,index)=>{if(previous[index]===undefined) delete process.env[key];else process.env[key]=previous[index];});}
  });
  it.each([
    ['XERO_SHARED_QUOTA_ENABLED',undefined],['XERO_SHARED_BACKOFF_ENABLED','false'],
    ['STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED','false'],['XERO_SHARED_QUOTA_ENABLED',' true '],
    ['XERO_SHARED_QUOTA_ENABLED','TRUE'],['XERO_SHARED_QUOTA_ENABLED','"true"'],
  ])('names the invalid dependency %s without exposing environment values',async(key,value)=>{
    const keys=['XERO_SHARED_QUOTA_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_RECHECKS_ENABLED'];
    const previous=keys.map(name=>process.env[name]);keys.forEach(name=>process.env[name]='true');
    if(value===undefined) delete process.env[key!];else process.env[key!]=value;
    try {
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow(`Missing or not exactly true: ${key}.`);
      expect(query).not.toHaveBeenCalled();
    } finally {keys.forEach((name,index)=>{if(previous[index]===undefined) delete process.env[name];else process.env[name]=previous[index];});}
  });
  it('returns only allowlisted boolean feature states after readiness succeeds',async()=>{
    const keys=['XERO_SHARED_QUOTA_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_RECHECKS_ENABLED'];
    const previous=keys.map(key=>process.env[key]);keys.forEach(key=>process.env[key]='true');
    query.mockResolvedValue({rows:[{ready:true}]});
    try {
      expect(await createSharedStudentSyncRuntime().preflight()).toEqual({...Object.fromEntries(keys.map(key=>[key,true])),STUDENT_SYNC_HEALTH_LOGS_ENABLED:false,STUDENT_DOCUMENT_ANALYSIS_ENABLED:false,STUDENT_OFFER_ANALYSIS_ENABLED:false});
    } finally {keys.forEach((key,index)=>{if(previous[index]===undefined) delete process.env[key];else process.env[key]=previous[index];});}
  });
  it('requires migration 085 before enabling document rechecks',async()=>{
    const keys=['XERO_SHARED_QUOTA_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_RECHECKS_ENABLED'];
    const previous=keys.map(key=>process.env[key]);keys.forEach(key=>process.env[key]='true');
    try {
      query.mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{ready:true}]})
        .mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{ready:true}]})
        .mockResolvedValueOnce({rows:[{ready:false}]});
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('085');
    } finally {keys.forEach((key,index)=>{if(previous[index]===undefined) delete process.env[key];else process.env[key]=previous[index];});}
  });
  it('checks for rechecks even when the old queue is empty, at most once per minute',async()=>{
    const previous=process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED;process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED='true';
    try {
      tenantRead.mockResolvedValue({rows:[]});const worker=createSharedStudentSyncRuntime();
      await worker.processDocument('tenant');await worker.processDocument('tenant');
      expect(scheduleRechecks).toHaveBeenCalledTimes(1);expect(scheduleRechecks).toHaveBeenCalledWith('tenant');
      expect(processOne).not.toHaveBeenCalled();
    } finally {if(previous===undefined) delete process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED;else process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED=previous;}
  });
  it.each([false,true])('requires quota dependencies and migration 084 (dependencies ready: %s)',async(ready)=>{
    const keys=['XERO_SHARED_QUOTA_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED','XERO_SHARED_BACKOFF_ENABLED'];
    const previous=keys.map(key=>process.env[key]);
    process.env.XERO_SHARED_QUOTA_ENABLED='true';process.env.XERO_SHARED_BACKOFF_ENABLED='true';
    process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED=String(ready);
    try {
      if(ready) query.mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{ready:true}]})
        .mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{ready:false}]});
      else query.mockResolvedValue({rows:[{ready:true}]});
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow(ready?'084':'Shared quota requires');
    } finally {keys.forEach((key,index)=>{if(previous[index]===undefined) delete process.env[key];else process.env[key]=previous[index];});}
  });
  it('fails startup with source deduplication enabled but migration 083 missing',async()=>{
    const oldSource=process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED,oldRate=process.env.XERO_SHARED_BACKOFF_ENABLED;
    process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED='true';process.env.XERO_SHARED_BACKOFF_ENABLED='true';
    try {
      query.mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{ready:false}]});
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('083');
    } finally {
      if(oldSource===undefined) delete process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED;else process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED=oldSource;
      if(oldRate===undefined) delete process.env.XERO_SHARED_BACKOFF_ENABLED;else process.env.XERO_SHARED_BACKOFF_ENABLED=oldRate;
    }
  });
  it('requires shared provider backoff before enabling source deduplication',async()=>{
    const oldSource=process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED,oldRate=process.env.XERO_SHARED_BACKOFF_ENABLED;
    process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED='true';delete process.env.XERO_SHARED_BACKOFF_ENABLED;
    try {
      query.mockResolvedValue({rows:[{ready:true}]});
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('requires shared Xero backoff');
    } finally {
      if(oldSource===undefined) delete process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED;else process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED=oldSource;
      if(oldRate===undefined) delete process.env.XERO_SHARED_BACKOFF_ENABLED;else process.env.XERO_SHARED_BACKOFF_ENABLED=oldRate;
    }
  });
  it('fails startup with shared backoff enabled but migration 082 missing',async()=>{
    const previous=process.env.XERO_SHARED_BACKOFF_ENABLED;process.env.XERO_SHARED_BACKOFF_ENABLED='true';
    try {
      query.mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{ready:false}]});
      await expect(createSharedStudentSyncRuntime().preflight()).rejects.toThrow('082');
    } finally {if(previous===undefined) delete process.env.XERO_SHARED_BACKOFF_ENABLED;else process.env.XERO_SHARED_BACKOFF_ENABLED=previous;}
  });
  it('fails startup without migration 081',async()=>{
    query.mockResolvedValue({rows:[{ready:false}]});
    const worker=createSharedStudentSyncRuntime();await expect(worker.preflight()).rejects.toThrow('080 and 081');
    await worker.close();expect(close).toHaveBeenCalled();
  });
  it('reuses the bounded durable invoice claim and existing lease processor',async()=>{
    query.mockResolvedValue({rows:[{customer_id:'tenant',sync_run_id:'run'}]});
    await createSharedStudentSyncRuntime().processInvoices();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('claim_due_student_operations_xero_worker_runs(1)'));
    expect(processInvoices).toHaveBeenCalledWith('tenant','run');
  });
  it('does not invoke document processing when attachment scopes are missing',async()=>{
    tenantRead.mockResolvedValue({rows:[{xero_connection_id:'connection'}]});
    status.mockResolvedValue({configured:true,connections:[{connectionId:'connection',status:'active',missingAttachmentScopes:['attachments']}]});
    const worker=createSharedStudentSyncRuntime();expect(await worker.processDocument('tenant')).toBe(false);
    expect(processOne).not.toHaveBeenCalled();
  });
  it('uses tenant-scoped metadata and the durable daily budget for ready documents',async()=>{
    tenantRead.mockResolvedValue({rows:[{xero_connection_id:'connection'}]});
    status.mockResolvedValue({configured:true,connections:[{connectionId:'connection',status:'active',missingAttachmentScopes:[]}]});
    const worker=createSharedStudentSyncRuntime();expect(await worker.processDocument('tenant')).toBe(true);
    expect(tenantRead).toHaveBeenCalledWith('tenant',expect.any(Function));
    expect(processOne).toHaveBeenCalledWith('tenant',{dailyBudget:true});
    await worker.processDocument('tenant');expect(status).toHaveBeenCalledTimes(1);
  });
});
