import {Body,Controller,Get,Header,Param,Post,Query,Req,UseGuards,BadRequestException} from '@nestjs/common';
import {z} from 'zod';
import {StudentOperationsWorkspaceGuard} from './student-operations-workspace.guard.js';
import type {StudentOperationsWorkspacePrincipal} from './student-operations-workspace.service.js';
import {StudentCommissionInvoicesService} from './student-commission-invoices.service.js';
import {StudentCaseInvoiceDraftsService} from './student-case-invoice-drafts.js';
type Request={studentOperationsPrincipal:StudentOperationsWorkspacePrincipal};
const sequences=z.array(z.number().int().positive()).max(200);
const paired=z.object({trustSequences:sequences,ptySequences:sequences,confirmed:z.literal(true)}).strict().refine(v=>v.trustSequences.length+v.ptySequences.length>0);
@Controller('business-packs/student-operations/v1/workspace/cases')
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentCommissionInvoicesController{
 constructor(private readonly commissions:StudentCommissionInvoicesService,private readonly trust:StudentCaseInvoiceDraftsService){}
 @Get(':caseId/commission-options') @Header('Cache-Control','private, no-store')
 options(@Req() r:Request,@Param('caseId') id:string,@Query('collegeId') collegeId:string){return this.commissions.options(r.studentOperationsPrincipal,id,collegeId);}
 @Get(':caseId/invoice-drafts/:batchId/commissions') @Header('Cache-Control','private, no-store')
 list(@Req() r:Request,@Param('caseId') id:string,@Param('batchId') batchId:string){return this.commissions.list(r.studentOperationsPrincipal,id,batchId);}
 @Post(':caseId/invoice-drafts/:batchId/commissions')
 prepare(@Req() r:Request,@Param('caseId') id:string,@Param('batchId') batchId:string,@Body() body:unknown){return this.commissions.prepare(r.studentOperationsPrincipal,id,batchId,body);}
 @Post(':caseId/invoice-drafts/:batchId/commissions/xero')
 create(@Req() r:Request,@Param('caseId') id:string,@Param('batchId') batchId:string,@Body() body:unknown){return this.commissions.create(r.studentOperationsPrincipal,id,batchId,body);}
 @Post(':caseId/invoice-drafts/:batchId/commissions/reconcile')
 reconcile(@Req() r:Request,@Param('caseId') id:string,@Param('batchId') batchId:string,@Body() body:unknown){const v=z.object({sequence:z.number().int().positive()}).strict().safeParse(body);if(!v.success)throw new BadRequestException('Select an invoice.');return this.commissions.reconcile(r.studentOperationsPrincipal,id,batchId,v.data.sequence);}
 @Post(':caseId/invoice-drafts/:batchId/paired-xero')
 async createPaired(@Req() r:Request,@Param('caseId') id:string,@Param('batchId') batchId:string,@Body() body:unknown){
  const v=paired.safeParse(body);if(!v.success)throw new BadRequestException('Review the invoice selection.');
  const p=r.studentOperationsPrincipal;
  const trust=v.data.trustSequences.length?await this.trust.createXero(p,id,batchId,{sequences:v.data.trustSequences,confirmed:true}):{created:0,skipped:0,results:[]};
  // TRUST phase is fully drained before any PTY attempt. The PTY service checks
  // its corresponding receipt again, including for direct individual requests.
  const pty=v.data.ptySequences.length?await this.commissions.create(p,id,batchId,{sequences:v.data.ptySequences,confirmed:true}):{created:0,skipped:0,results:[]};
  return {trust,pty};
 }
}
