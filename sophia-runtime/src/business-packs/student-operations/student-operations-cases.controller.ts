import { Body,Controller,Delete,Get,Header,Headers,Param,Patch,Post,Put,Query,Req,StreamableFile,UseGuards,UseInterceptors,UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StudentDocumentTypesService } from './student-document-types.service.js';
import { StudentCaseInvoiceDraftsService } from './student-case-invoice-drafts.js';
import { StudentDocumentAnalysisService } from './student-document-analysis.service.js';
import { StudentOperationsWorkspaceGuard } from './student-operations-workspace.guard.js';
import { StudentOperationsCasesService } from './student-operations-cases.service.js';
import { StudentOperationsCaseDocumentsService } from './student-operations-case-documents.service.js';
import type { StudentOperationsWorkspacePrincipal } from './student-operations-workspace.service.js';
type Request={studentOperationsPrincipal:StudentOperationsWorkspacePrincipal};
@Controller('business-packs/student-operations/v1/workspace/cases')
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentOperationsCasesController {
  constructor(private readonly cases:StudentOperationsCasesService,private readonly documents:StudentOperationsCaseDocumentsService,private readonly types:StudentDocumentTypesService,private readonly analysis:StudentDocumentAnalysisService,private readonly drafts:StudentCaseInvoiceDraftsService) {}
  @Get(':caseId/invoice-drafts')
  @Header('Cache-Control','private, no-store')
  invoiceDrafts(@Req() r:Request,@Param('caseId') id:string){return this.drafts.list(r.studentOperationsPrincipal,id);}
  @Post(':caseId/invoice-drafts')
  prepareInvoiceDrafts(@Req() r:Request,@Param('caseId') id:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.drafts.prepare(r.studentOperationsPrincipal,id,body,key);}
  @Post(':caseId/invoice-drafts/:batchId/xero')
  createXeroInvoices(@Req() r:Request,@Param('caseId') id:string,@Param('batchId') batchId:string,@Body() body:unknown){return this.drafts.createXero(r.studentOperationsPrincipal,id,batchId,body);}
  @Post(':caseId/invoice-drafts/:batchId/xero/reconcile')
  reconcileXeroInvoice(@Req() r:Request,@Param('caseId') id:string,@Param('batchId') batchId:string,@Body() body:unknown){return this.drafts.reconcileXero(r.studentOperationsPrincipal,id,batchId,body);}
  @Get(':caseId/documents/:documentId/analysis')
  @Header('Cache-Control','private, no-store')
  analysisStatus(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') doc:string){return this.analysis.get(r.studentOperationsPrincipal,id,doc);}
  @Post(':caseId/documents/:documentId/analysis/review') reviewDocument(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') doc:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.analysis.review(r.studentOperationsPrincipal,id,doc,body,key);}
  @Post(':caseId/documents/:documentId/analysis/retry') retryAnalysis(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') doc:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.analysis.retry(r.studentOperationsPrincipal,id,doc,body,key);}
  @Post(':caseId/documents/:documentId/analysis/start') startAnalysis(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') doc:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.analysis.start(r.studentOperationsPrincipal,id,doc,body,key);}
  @Get('document-types') documentTypes(@Req() r:Request){return this.types.list(r.studentOperationsPrincipal);}
  @Get('document-requirements') documentRequirements(@Req() r:Request,@Query() query:unknown){return this.types.requirements(r.studentOperationsPrincipal,query);}
  @Post('document-types') createType(@Req() r:Request,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.types.create(r.studentOperationsPrincipal,body,key);}
  @Patch('document-types/:typeId') updateType(@Req() r:Request,@Param('typeId') id:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.types.update(r.studentOperationsPrincipal,id,body,key);}
  @Post(':caseId/documents/upload')
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:10*1024*1024,files:1,fields:3,fieldSize:100,parts:4}}))
  upload(@Req() r:Request,@Param('caseId') id:string,@Body() body:unknown,@UploadedFile() file:{buffer:Buffer;originalname:string;mimetype:string}|undefined,@Headers('idempotency-key') key?:string){return this.documents.upload(r.studentOperationsPrincipal,id,body,file,key);}
  @Get(':caseId/documents/upload-options') uploadOptions(@Req() r:Request,@Param('caseId') id:string){return this.documents.uploadOptions(r.studentOperationsPrincipal,id);}
  @Get('options') options(){return this.cases.options();}
  @Get('edit-options') editOptions(@Req() r:Request){return this.cases.editOptions(r.studentOperationsPrincipal);}
  @Get() list(@Req() r:Request,@Query() query:unknown){return this.cases.list(r.studentOperationsPrincipal,query);}
  @Post() create(@Req() r:Request,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.cases.create(r.studentOperationsPrincipal,body,key);}
  @Post('student') createStudent(@Req() r:Request,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.cases.createStudent(r.studentOperationsPrincipal,body,key);}
  @Get(':caseId') get(@Req() r:Request,@Param('caseId') id:string){return this.cases.get(r.studentOperationsPrincipal,id);}
  @Patch(':caseId') update(@Req() r:Request,@Param('caseId') id:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.cases.update(r.studentOperationsPrincipal,id,body,key);}
  @Get(':caseId/invoices') invoices(@Req() r:Request,@Param('caseId') id:string,@Query() query:unknown){return this.cases.invoices(r.studentOperationsPrincipal,id,query);}
  @Get(':caseId/invoices/:connectionId/:invoiceId')
  @Header('Cache-Control','private, no-store')
  invoiceDetail(@Req() r:Request,@Param('caseId') id:string,@Param('connectionId') connectionId:string,@Param('invoiceId') invoiceId:string){return this.cases.invoiceDetail(r.studentOperationsPrincipal,id,connectionId,invoiceId);}
  @Get(':caseId/invoices/:invoiceId')
  @Header('Cache-Control','private, no-store')
  invoiceDetailById(@Req() r:Request,@Param('caseId') id:string,@Param('invoiceId') invoiceId:string){return this.cases.invoiceDetail(r.studentOperationsPrincipal,id,null,invoiceId);}
  @Post(':caseId/invoices') linkInvoice(@Req() r:Request,@Param('caseId') id:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.cases.linkInvoice(r.studentOperationsPrincipal,id,body,key);}
  @Get(':caseId/activity') activity(@Req() r:Request,@Param('caseId') id:string,@Query() query:unknown){return this.cases.activities(r.studentOperationsPrincipal,id,query);}
  @Get(':caseId/checklist') checklist(@Req() r:Request,@Param('caseId') id:string){return this.cases.checklist(r.studentOperationsPrincipal,id);}
  @Get(':caseId/checklist/progress') checklistProgress(@Req() r:Request,@Param('caseId') id:string){return this.cases.checklistProgress(r.studentOperationsPrincipal,id);}
  @Patch(':caseId/checklist') updateChecklist(@Req() r:Request,@Param('caseId') id:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.cases.updateChecklist(r.studentOperationsPrincipal,id,body,key);}
  @Get(':caseId/documents') listDocuments(@Req() r:Request,@Param('caseId') id:string,@Query() query:unknown){return this.documents.list(r.studentOperationsPrincipal,id,query);}
  @Post(':caseId/documents/discovery') discover(@Req() r:Request,@Param('caseId') id:string){return this.documents.enqueue(r.studentOperationsPrincipal,id);}
  @Put(':caseId/documents/:documentId/content')
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:10*1024*1024,files:1,fields:0,parts:1}}))
  replaceDocument(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') documentId:string,@UploadedFile() file:{buffer:Buffer;originalname:string;mimetype:string}|undefined,@Headers('idempotency-key') key?:string){return this.documents.replace(r.studentOperationsPrincipal,id,documentId,file,key);}
  @Get(':caseId/documents/:documentId/content')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  async content(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') documentId:string){
    const file=await this.documents.content(r.studentOperationsPrincipal,id,documentId);
    return new StreamableFile(file.buffer,{type:'application/octet-stream',disposition:`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,length:file.buffer.length});
  }
  @Delete(':caseId/documents/:documentId')
  removeDocument(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') documentId:string,@Headers('idempotency-key') key?:string){return this.documents.remove(r.studentOperationsPrincipal,id,documentId,key);}
}
