import {jest} from '@jest/globals';
import {createStudentConsultationTools} from './student-consultation.tools.js';
import {ToolRegistry} from '../tool-registry.js';
import type {BusinessManagerClient} from '../real-estate/business-manager.client.js';
const details={slotId:'30000000-0000-4000-8000-000000000001',confirmedStartsAt:'2026-10-01T00:00:00Z',customerName:'Test Customer',customerEmail:'test@example.com'};
function setup(){
 const book=jest.fn<BusinessManagerClient['bookStudentConsultation']>().mockResolvedValue({consultationBooking:{}});
 const review=jest.fn<BusinessManagerClient['reviewStudentConsultation']>().mockResolvedValue({consultationReview:{...details}});
 const state:{clear?:(id?:string)=>void}={};const registry=new ToolRegistry();
 for(const tool of createStudentConsultationTools({bookStudentConsultation:book,reviewStudentConsultation:review} as unknown as BusinessManagerClient,state))registry.register(tool);
 const run=(name:string,input:unknown,sessionId='session')=>registry.execute(name,input,{customerId:'demo',sessionId});
 return {book,run,state};
}
it('requires matching review and explicit confirmation, scoped to the session',async()=>{
 const {book,run}=setup();
 await expect(run('bookStudentConsultation',{...details,confirmed:true})).rejects.toThrow('Display');
 await run('reviewStudentConsultation',details);
 await expect(run('bookStudentConsultation',{...details,confirmed:false})).rejects.toThrow();
 await expect(run('bookStudentConsultation',{...details,confirmed:true},'another')).rejects.toThrow('Display');
 await expect(run('bookStudentConsultation',{...details,customerEmail:'changed@example.com',confirmed:true})).rejects.toThrow('Display');
 await expect(run('bookStudentConsultation',{...details,includeSummary:true,enquirySummary:'Private',confirmed:true})).rejects.toThrow('Display');
 await run('bookStudentConsultation',{...details,confirmed:true});expect(book).toHaveBeenCalledTimes(1);
 expect(book.mock.calls[0]?.[0]).toMatchObject({includeSummary:false,enquirySummary:'',sourceLinks:[],idempotencyKey:expect.stringContaining('student:session:')});
});
it('retains reviewed details after API failure and clears them on domain switch',async()=>{
 const {book,run,state}=setup();await run('reviewStudentConsultation',details);book.mockRejectedValueOnce(new Error('offline'));
 await expect(run('bookStudentConsultation',{...details,confirmed:true})).rejects.toThrow('offline');
 await run('bookStudentConsultation',{...details,confirmed:true});expect(book).toHaveBeenCalledTimes(2);
 await run('reviewStudentConsultation',details);state.clear?.('session');
 await expect(run('bookStudentConsultation',{...details,confirmed:true})).rejects.toThrow('Display');
});
it('requires the assistant to ask for confirmation after displaying the review',async()=>{
 const {run}=setup();
 const result=await run('reviewStudentConsultation',details) as any;
 expect(result.guidance).toContain('Are these details correct, and may I book the appointment?');
 expect(result.guidance).toContain('wait for the customer to answer in a new turn');
});
