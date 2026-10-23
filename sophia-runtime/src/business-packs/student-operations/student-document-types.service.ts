import { BadRequestException,ConflictException,ForbiddenException,Inject,Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { StudentOperationsCasesService,caseSchema,caseId } from './student-operations-cases.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';

const fields=z.object({name:z.string().trim().min(1).max(120).transform(v=>v.replace(/\s+/g,' ')),required:z.boolean()}).strict();
@Injectable()
export class StudentDocumentTypesService {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService) {}
  private manage(p:Principal) { if(!hasStudentOperationsPermission(p.role,'cases.manage')) throw new ForbiddenException(); }
  async list(p:Principal) {
    if(!hasStudentOperationsPermission(p.role,'documents.metadata.read_all') && !hasStudentOperationsPermission(p.role,'documents.metadata.read_assigned')) throw new ForbiddenException();
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      const result=await db.query(`SELECT document_type_id AS "documentTypeId",name,required,status,record_version AS "recordVersion" FROM ${caseSchema()}.student_operations_document_types WHERE customer_id=$1 AND status='active' ORDER BY lower(name),document_type_id`,[p.tenantId]);
      return {types:result.rows};
    });
  }
  async create(p:Principal,input:unknown,key?:string) {
    this.manage(p);
    const parsed=fields.safeParse(input); if(!parsed.success) throw new BadRequestException('Enter a document type name and required setting.');
    return this.save(p,'document_type.create',parsed.data,key,async db=>{
      const result=await db.query(`INSERT INTO ${caseSchema()}.student_operations_document_types(customer_id,company_id,name,required)
        VALUES($1,$2,$3,$4)
        RETURNING document_type_id AS "documentTypeId",name,required,status,record_version AS "recordVersion"`,[p.tenantId,caseId(p.externalCompanyId),parsed.data.name,parsed.data.required]);
      if(!result.rows[0]) throw new ForbiddenException();
      await this.audit(db,p,result.rows[0].documentTypeId,'created'); return result.rows[0];
    });
  }
  async update(p:Principal,id:string,input:unknown,key?:string) {
    this.manage(p); caseId(id);
    const parsed=fields.partial().extend({status:z.literal('archived').optional(),recordVersion:z.number().int().positive()}).strict().safeParse(input);
    if(!parsed.success || Object.keys(parsed.data).length<2) throw new BadRequestException('Invalid document type update.');
    const v=parsed.data;
    return this.save(p,'document_type.update',{id,...v},key,async db=>{
      const result=await db.query(`UPDATE ${caseSchema()}.student_operations_document_types SET name=COALESCE($3,name),required=COALESCE($4,required),status=COALESCE($5,status),record_version=record_version+1,updated_at=now()
        WHERE customer_id=$1 AND document_type_id=$2 AND status='active' AND record_version=$6
        RETURNING document_type_id AS "documentTypeId",name,required,status,record_version AS "recordVersion"`,[p.tenantId,id,v.name??null,v.required??null,v.status??null,v.recordVersion]);
      if(!result.rows[0]) throw new ConflictException('The document type changed or was archived. Reload the list.');
      await this.audit(db,p,id,v.status==='archived'?'archived':'updated'); return result.rows[0];
    });
  }
  private async save(p:Principal,op:string,value:unknown,key:string|undefined,work:Parameters<StudentOperationsCasesService['write']>[4]) {
    try { return await this.cases.write(p,op,value,key,work); }
    catch(error) { if((error as {code?:string}).code==='23505') throw new ConflictException('An active document type with that name already exists.'); throw error; }
  }
  private async audit(db:import('pg').PoolClient,p:Principal,id:string,event:string) {
    await db.query(`INSERT INTO ${caseSchema()}.student_operations_document_type_events(customer_id,document_type_id,actor_identity_user_id,event_type) VALUES($1,$2,$3,$4)`,[p.tenantId,id,p.identityUserId,event]);
  }
}
