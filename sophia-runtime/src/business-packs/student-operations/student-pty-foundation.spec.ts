import {afterAll,beforeAll,describe,it,expect,jest} from '@jest/globals';
import {ConflictException,ForbiddenException,NotFoundException} from '@nestjs/common';
import {StudentOperationsXeroSyncService} from './student-operations-xero-sync.service.js';
import {StudentCollegeMatchingService} from './student-college-matching.service.js';
import {StudentOperationsXeroController} from './student-operations-xero.controller.js';

const tenant='11111111-1111-4111-8111-111111111111',connection='22222222-2222-4222-8222-222222222222',contact='33333333-3333-4333-8333-333333333333',college='44444444-4444-4444-8444-444444444444';
const principal={tenantId:tenant,identityUserId:'chief',role:'chief_executive'} as never;
const prior=process.env.SOPHIA_RUNTIME_DATABASE_URL;
beforeAll(()=>{process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';});
afterAll(()=>{if(prior===undefined)delete process.env.SOPHIA_RUNTIME_DATABASE_URL;else process.env.SOPHIA_RUNTIME_DATABASE_URL=prior;});
function database(query:unknown){return {tenantTransaction:async(_tenant:string,fn:(db:unknown)=>Promise<unknown>)=>fn({query}),tenantReadTransaction:async(_tenant:string,fn:(db:unknown)=>Promise<unknown>)=>fn({query})} as never;}

describe('PTY organisation isolation',()=>{
  it('does not silently configure an unassigned connection as Trust on refresh',async()=>{
    const query=jest.fn(async(sql:string)=>({rows:sql.includes('FROM sophia_runtime.xero_connections')?[{}]:[],rowCount:1}));
    const service=new StudentOperationsXeroSyncService(database(query),{} as never);
    await expect(service.enqueueManual(principal,connection)).rejects.toThrow(ConflictException);
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO'))).toBe(false);
  });
  it('refuses to reinterpret a Trust connection as PTY',async()=>{
    const query=jest.fn(async(sql:string)=>({rows:sql.includes('SELECT organisation_role')?[{organisation_role:'trust'}]:[{ready:true}],rowCount:1}));
    const service=new StudentOperationsXeroSyncService(database(query),{} as never);
    await expect(service.configureOrganisation(principal,connection,'operating')).rejects.toThrow(ConflictException);
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO'))).toBe(false);
  });
  it('assigns PTY explicitly without disabling the Trust source',async()=>{
    const query=jest.fn(async(sql:string,_args?:unknown[])=>({rows:sql.includes('SELECT organisation_role')?[]:[{ready:true}],rowCount:1}));
    const service=new StudentOperationsXeroSyncService(database(query),{} as never);
    await expect(service.configureOrganisation(principal,connection,'operating')).resolves.toEqual({connectionId:connection,organisationRole:'operating'});
    const update=query.mock.calls.find(([sql])=>sql.includes('SET enabled=false'))!;
    expect(update[1]).toEqual([tenant,connection,'operating']);
  });
  it.each([true,false])('preserves the student reference and uses only confirmed college mappings (mapped=%s)',async mapped=>{
    const query=jest.fn(async(sql:string)=>{
      if(sql.includes('SELECT organisation_role'))return {rows:[{organisation_role:'operating'}],rowCount:1};
      if(sql.includes('SELECT m.xero_contact_id'))return {rows:mapped?[{xero_contact_id:contact,college_id:college,college_name:'Australian College',classification:'college'}]:[],rowCount:1};
      if(sql.includes('SELECT i.xero_invoice_id'))return {rows:[{xero_invoice_id:college,xero_contact_id:contact,invoice_type:'ACCREC',invoice_status:'DRAFT',invoice_reference:'S15 Andres Student',legal_name:'Australian College PTY contact',college_name:'S15 Andres Student',total:'216',amount_paid:'0',amount_due:'216',total_count:1}],rowCount:1};
      return {rows:[{}],rowCount:1};
    });
    const service=new StudentOperationsXeroSyncService(database(query),{} as never);
    const result=await service.invoices(tenant,connection,{});
    expect(result.invoices[0]).toMatchObject({reference:'S15 Andres Student',contactName:'Australian College PTY contact',collegeName:mapped?'Australian College':null,studentId:null,matchingStatus:mapped?'college':'unresolved'});
  });
  it('denies PTY configuration to an operations role before service access',()=>{
    const configureOrganisation=jest.fn();const controller=new StudentOperationsXeroController({} as never,{configureOrganisation} as never,{} as never);
    expect(()=>controller.configureOperating({studentOperationsPrincipal:{tenantId:tenant,role:'operations'} as never},connection)).toThrow(ForbiddenException);
    expect(configureOrganisation).not.toHaveBeenCalled();
  });
});

describe('College mapping decisions',()=>{
  function service(options:{role?:string;revision?:number;missingCollege?:boolean}={}){
    const query=jest.fn(async(sql:string,_args?:unknown[])=>{
      if(sql.includes('SELECT c.xero_connection_id'))return {rows:options.role==='trust'?[]:[{xero_connection_id:connection}]};
      if(sql.includes('SELECT college_id FROM'))return {rows:options.missingCollege?[]:[{college_id:college}]};
      if(sql.includes('SELECT college_id,classification,revision'))return {rows:options.revision?[{college_id:college,classification:'college',revision:options.revision}]:[]};
      if(sql.includes('RETURNING college_id'))return {rows:[{college_id:college,classification:'college',revision:(options.revision??0)+1}]};
      return {rows:[{}]};
    });return {query,service:new StudentCollegeMatchingService(database(query))};
  }
  it('rejects Trust contacts and cross-company colleges',async()=>{
    await expect(service({role:'trust'}).service.resolve(principal,connection,contact,{classification:'college',collegeId:college,expectedRevision:0})).rejects.toThrow(NotFoundException);
    await expect(service({missingCollege:true}).service.resolve(principal,connection,contact,{classification:'college',collegeId:college,expectedRevision:0})).rejects.toThrow('available college');
  });
  it('rejects stale mapping decisions without writing',async()=>{
    const s=service({revision:2});await expect(s.service.resolve(principal,connection,contact,{classification:'college',collegeId:college,expectedRevision:1})).rejects.toThrow(ConflictException);
    expect(s.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
  });
  it('records the confirmed mapping and audit in the tenant transaction',async()=>{
    const s=service();await s.service.resolve(principal,connection,contact,{classification:'college',collegeId:college,expectedRevision:0});
    const event=s.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO sophia_runtime.student_college_xero_mapping_events'))!;
    expect(event[1]?.slice(0,4)).toEqual([tenant,connection,contact,'chief']);
    expect(s.query.mock.calls.some(([sql])=>sql.includes('users')||sql.includes('UPDATE sophia_runtime.student_operations_xero_invoices'))).toBe(false);
  });
});
