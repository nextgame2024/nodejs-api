import { Body,Controller,Get,Header,Headers,Param,Patch,Post,Query,Req,StreamableFile,UseGuards,UseInterceptors,UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StudentDocumentTypesService } from './student-document-types.service.js';
import { StudentOperationsWorkspaceGuard } from './student-operations-workspace.guard.js';
import { StudentOperationsCasesService } from './student-operations-cases.service.js';
import { StudentOperationsCaseDocumentsService } from './student-operations-case-documents.service.js';
import type { StudentOperationsWorkspacePrincipal } from './student-operations-workspace.service.js';
type Request={studentOperationsPrincipal:StudentOperationsWorkspacePrincipal};
@Controller('business-packs/student-operations/v1/workspace/cases')
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentOperationsCasesController {
  constructor(private readonly cases:StudentOperationsCasesService,private readonly documents:StudentOperationsCaseDocumentsService,private readonly types:StudentDocumentTypesService) {}
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
  @Post(':caseId/invoices') linkInvoice(@Req() r:Request,@Param('caseId') id:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.cases.linkInvoice(r.studentOperationsPrincipal,id,body,key);}
  @Get(':caseId/activity') activity(@Req() r:Request,@Param('caseId') id:string,@Query() query:unknown){return this.cases.activities(r.studentOperationsPrincipal,id,query);}
  @Get(':caseId/checklist') checklist(@Req() r:Request,@Param('caseId') id:string){return this.cases.checklist(r.studentOperationsPrincipal,id);}
  @Patch(':caseId/checklist') updateChecklist(@Req() r:Request,@Param('caseId') id:string,@Body() body:unknown,@Headers('idempotency-key') key?:string){return this.cases.updateChecklist(r.studentOperationsPrincipal,id,body,key);}
  @Get(':caseId/documents') listDocuments(@Req() r:Request,@Param('caseId') id:string,@Query() query:unknown){return this.documents.list(r.studentOperationsPrincipal,id,query);}
  @Post(':caseId/documents/discovery') discover(@Req() r:Request,@Param('caseId') id:string){return this.documents.enqueue(r.studentOperationsPrincipal,id);}
  @Get(':caseId/documents/:documentId/content')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  async content(@Req() r:Request,@Param('caseId') id:string,@Param('documentId') documentId:string){
    const file=await this.documents.content(r.studentOperationsPrincipal,id,documentId);
    return new StreamableFile(file.buffer,{type:'application/octet-stream',disposition:`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,length:file.buffer.length});
  }
}
