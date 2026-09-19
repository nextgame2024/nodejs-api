import {jest} from '@jest/globals';
import {ToolRegistryService} from './tools.service.js';
import type {DatabaseService} from '../database/database.service.js';
import type {BusinessResearchService} from './research/business-research.service.js';
import type {BusinessManagerClient} from './real-estate/business-manager.client.js';
const details={slotId:'30000000-0000-4000-8000-000000000001',confirmedStartsAt:'2026-10-01T00:00:00Z',customerName:'Test Customer',customerEmail:'demo@example.com'};
const property={...details,propertyId:'10000000-0000-4000-8000-000000000001',propertyAddress:'Demo property',startsAtLabel:'1 Oct, 10 am'};
const original=process.env.SOPHIA_RUNTIME_DATABASE_URL;
beforeEach(()=>{process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://test:test@localhost/test';});
afterEach(()=>{if(original===undefined)delete process.env.SOPHIA_RUNTIME_DATABASE_URL;else process.env.SOPHIA_RUNTIME_DATABASE_URL=original;});
function setup(){
 const book=jest.fn<BusinessManagerClient['bookStudentConsultation']>().mockResolvedValue({consultationBooking:{}});
 const client={reviewStudentConsultation:async()=>({consultationReview:details}),bookStudentConsultation:book,verifyStudentRules:async()=>({sources:[]}),searchProperties:async()=>({properties:[]})};
 const service=new ToolRegistryService({query:async()=>({rows:[]})} as unknown as DatabaseService,{} as BusinessResearchService,client as unknown as BusinessManagerClient);
 const run=(name:string,input:unknown,sessionId='one')=>service.execute(name,input,{sessionId,customerId:'demo'});
 return {run,book};
}
it('switches inspection to student and invalidates the old property review',async()=>{
 const {run}=setup();await run('reviewInspectionBooking',property);await run('verifyStudentRules',{topic:'work'});
 await expect(run('bookInspection',{...property,confirmed:true})).rejects.toThrow();
});
it('switches student to property without invalidating another session',async()=>{
 const {run,book}=setup();await run('reviewStudentConsultation',details);await run('reviewStudentConsultation',details,'two');
 await run('searchProperties',{listingType:'rent'});
 await expect(run('bookStudentConsultation',{...details,confirmed:true})).rejects.toThrow('Display');
 await run('bookStudentConsultation',{...details,confirmed:true},'two');expect(book).toHaveBeenCalledTimes(1);
});
it.each(['closePropertyView','closeStudentView'])('closing %s clears the consultation review',async name=>{
 const {run}=setup();await run('reviewStudentConsultation',details);await run(name,{});
 await expect(run('bookStudentConsultation',{...details,confirmed:true})).rejects.toThrow('Display');
});
