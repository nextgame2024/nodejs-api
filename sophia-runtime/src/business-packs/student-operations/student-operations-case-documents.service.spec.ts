import { jest } from '@jest/globals';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { StudentOperationsCasesService } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal } from './student-operations-workspace.service.js';
import { StudentOperationsCaseDocumentsService } from './student-operations-case-documents.service.js';

describe('StudentOperationsCaseDocumentsService replacement finalization',()=>{
  test('preserves committed replacement success when cleanup bookkeeping fails',async()=>{
    const tenantId='11111111-1111-4111-8111-111111111111';
    const caseId='22222222-2222-4222-8222-222222222222';
    const documentId='33333333-3333-4333-8333-333333333333';
    const replacementId='44444444-4444-4444-8444-444444444444';
    const oldFileId='55555555-5555-4555-8555-555555555555';
    const connectionId='66666666-6666-4666-8666-666666666666';
    const transaction=jest.fn()
      .mockResolvedValueOnce({replacement_id:replacementId,status:'committed',storage_provider:'xero_files',old_provider_file_id:oldFileId,
        document:{xero_connection_id:connectionId}})
      .mockRejectedValueOnce(new Error('temporary database failure'));
    const deleteFile=jest.fn().mockResolvedValue(undefined);
    const service=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction} as unknown as DatabaseService,
      {} as StudentOperationsCasesService,{deleteFile} as unknown as XeroConnectorService);
    const principal={tenantId,identityUserId:'actor',role:'chief_executive'} as StudentOperationsWorkspacePrincipal;
    const file={buffer:Buffer.from('%PDF-1.7\nReplacement\n%%EOF'),originalname:'replacement.pdf',mimetype:'application/pdf'};

    await expect(service.replace(principal,caseId,documentId,file,'replacement-unit-key'))
      .resolves.toEqual({documentId,replaced:true,cleanupPending:true});
    expect(deleteFile).toHaveBeenCalledWith(tenantId,connectionId,oldFileId);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
