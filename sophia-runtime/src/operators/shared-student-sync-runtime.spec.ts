import {jest} from '@jest/globals';

const query=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const tenantRead=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const close=jest.fn(async()=>{});
const processInvoices=jest.fn(async(..._args:unknown[])=>{});
const processOne=jest.fn(async(..._args:unknown[])=>true);
const status=jest.fn<(...args:unknown[])=>Promise<unknown>>();
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
