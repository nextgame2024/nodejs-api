import {expect,it,jest} from '@jest/globals';
jest.unstable_mockModule('../src/config/db.js',()=>({default:{}}));
const {normalizeConsultationInput,bookConsultation}=await import('../src/services/bm.studentConsultation.service.js');
const {consultationEmailMessage}=await import('../src/services/bm.studentConsultationEmail.service.js');
const {processStudentConsultationEmailCycle}=await import('../src/services/bm.studentConsultationWorker.service.js');
const input={slotId:'30000000-0000-4000-8000-000000000001',confirmedStartsAt:'2026-10-01T00:00:00Z',customerName:' Test Customer ',customerEmail:' TEST@example.com ',includeSummary:false,enquirySummary:'private summary',sourceLinks:['https://example.com']};
it('normalizes details and excludes summary and sources without consent',()=>{
 expect(normalizeConsultationInput(input)).toMatchObject({customerName:'Test Customer',customerEmail:'test@example.com',enquirySummary:'',sourceLinks:[]});
 expect(()=>normalizeConsultationInput({...input,includeSummary:true})).toThrow('official');
 expect(()=>normalizeConsultationInput({...input,customerEmail:'wrong'})).toThrow('valid email');
});
it('requires explicit confirmation before writing',async()=>{await expect(bookConsultation('company',input)).rejects.toThrow('confirmation');});
it('labels demo email, escapes content and respects summary consent',()=>{
 const booking={...input,startsAt:input.confirmedStartsAt,timeZone:'Australia/Brisbane',isDemo:true,customerName:'<script>',serviceName:'Student enquiry',bookingId:'reference'};
 const message=consultationEmailMessage(booking);
 expect(message.html).toContain('No real adviser meeting');expect(message.html).toContain('&lt;script&gt;');expect(message.html).not.toContain('private summary');
 expect(consultationEmailMessage({...booking,includeSummary:true,sourceLinks:[]}).html).toContain('private summary');
 expect(message.attachments).toBeUndefined();
});
it.each(['sent','logged'])('records provider result %s and releases worker lock',async status=>{
 const release=jest.fn();const model={acquireLock:async()=>({release}),claimEmail:async()=>({deliveryId:'delivery'}),finishEmail:jest.fn(),failEmail:jest.fn()};
 expect(await processStudentConsultationEmailCycle({model,sendEmail:async()=>status,id:'worker'})).toMatchObject({status});
 expect(model.finishEmail).toHaveBeenCalledWith('delivery','worker',status);expect(model.failEmail).not.toHaveBeenCalled();expect(release).toHaveBeenCalled();
});
it('retries failed sending and never marks it sent',async()=>{
 const release=jest.fn();const model={acquireLock:async()=>({release}),claimEmail:async()=>({deliveryId:'delivery'}),finishEmail:jest.fn(),failEmail:jest.fn(async()=> 'retry')};
 expect(await processStudentConsultationEmailCycle({model,sendEmail:async()=>{throw new Error('provider unavailable');},id:'worker'})).toMatchObject({status:'retry'});
 expect(model.finishEmail).not.toHaveBeenCalled();expect(model.failEmail).toHaveBeenCalledWith('delivery','worker','provider unavailable');expect(release).toHaveBeenCalled();
});
it('does not process while another worker owns the lock',async()=>{
 const model={acquireLock:async()=>null,claimEmail:jest.fn()};expect(await processStudentConsultationEmailCycle({model})).toEqual({status:'lock_busy'});expect(model.claimEmail).not.toHaveBeenCalled();
});
