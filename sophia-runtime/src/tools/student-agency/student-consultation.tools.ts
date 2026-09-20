import {z} from 'zod';
import type {RuntimeTool,RuntimeToolContext} from '../tool-registry.js';
import type {BusinessManagerClient} from '../real-estate/business-manager.client.js';
const details={
  slotId:z.string().uuid(),confirmedStartsAt:z.string().datetime({offset:true}),
  customerName:z.string().trim().min(2).max(120),customerEmail:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),
  includeSummary:z.boolean().default(false),enquirySummary:z.string().trim().max(2000).default(''),sourceLinks:z.array(z.string().url()).max(5).default([]),
};
const parameters={
  slotId:{type:'string'},confirmedStartsAt:{type:'string',description:'Copy the selected startsAt timestamp exactly.'},
  customerName:{type:'string'},customerEmail:{type:'string'},includeSummary:{type:'boolean',description:'True only when the customer wants the displayed summary and links included.'},
  enquirySummary:{type:'string'},sourceLinks:{type:'array',items:{type:'string'}},
};
const required=['slotId','confirmedStartsAt','customerName','customerEmail'];
const normalize=(input:Record<string,any>)=>({...input,enquirySummary:input.includeSummary ? input.enquirySummary : '',sourceLinks:input.includeSummary ? input.sourceLinks : []});
const session=(context:RuntimeToolContext)=>{if(!context.sessionId)throw new Error('A session is required for consultation booking');return context.sessionId;};
export const STUDENT_CONSULTATION_TOOL_NAMES=['getStudentConsultationSlots','reviewStudentConsultation','bookStudentConsultation','getStudentConsultationBooking','reviewStudentConsultationEmail','resendStudentConsultationEmail'];

export function createStudentConsultationTools(client:BusinessManagerClient,state?:{clear?:(sessionId?:string)=>void}):RuntimeTool<any,unknown>[] {
  const pending=new Map<string,{mode:'new'|'resend';input:Record<string,any>;expiresAt:number}>();
  if(state)state.clear=id=>{if(id)pending.delete(id);};
  const save=(id:string,mode:'new'|'resend',input:Record<string,any>)=>{
    for(const [key,value] of pending)if(value.expiresAt<Date.now())pending.delete(key);
    pending.set(id,{mode,input,expiresAt:Date.now()+10*60_000});
  };
  return [{
    definition:{name:'getStudentConsultationSlots',description:'Get authoritative student-adviser consultation times. Demo slots must be described as demonstration appointments, not real agent meetings. Never use property inspection times for this.',parameters:{type:'object',additionalProperties:false,properties:{}}},
    inputSchema:z.object({}).strict(),execute:()=>client.getStudentConsultationSlots(),
  },{
    definition:{name:'reviewStudentConsultation',description:'Display authoritative consultation time, adviser, editable name/email and optional enquiry summary for review before booking. Ask the customer to check the details and email spelling, explain demo status, then wait for explicit confirmation. Corrections require another review. Include summary/links only with consent.',parameters:{type:'object',additionalProperties:false,properties:parameters,required}},
    inputSchema:z.object(details).strict().transform(normalize),
    execute:async(input,context)=>{
      const id=session(context);const result=await client.reviewStudentConsultation(input) as {consultationReview:Record<string,any>};
      if(!result.consultationReview)throw new Error('Consultation review was unavailable');
      save(id,'new',input);return {...result,guidance:'The booking details are now displayed. Say exactly: Please check your name, email and appointment time. Are these details correct, and may I book the appointment? Then stop and wait for the customer to answer in a new turn. Do not call bookStudentConsultation yet.'};
    },
  },{
    definition:{name:'bookStudentConsultation',description:'Book only after the displayed consultation details have been explicitly confirmed. Use the reviewed details exactly and confirmed true. Report demo status and authoritative returned time/email. Email queued/retry is not sent; logged means no email was delivered.',parameters:{type:'object',additionalProperties:false,properties:{...parameters,confirmed:{type:'boolean'}},required:[...required,'confirmed']}},
    inputSchema:z.object({...details,confirmed:z.literal(true)}).strict().transform(normalize),
    execute:async(input,context)=>{
      const id=session(context);const review=pending.get(id);
      if(!review || review.mode!=='new' || review.expiresAt<Date.now() || required.concat(['includeSummary','enquirySummary','sourceLinks']).some(key=>JSON.stringify(review.input[key])!==JSON.stringify(input[key])))throw new Error('Display and confirm these consultation details before booking');
      const result=await client.bookStudentConsultation({...input,idempotencyKey:`student:${id}:${input.slotId}:${input.customerEmail}`});
      if(pending.get(id)===review)pending.delete(id);return result;
    },
  },{
    definition:{name:'getStudentConsultationBooking',description:'Check an existing student consultation and its current email delivery status. This does not send email.',parameters:{type:'object',additionalProperties:false,properties:{bookingId:{type:'string'}},required:['bookingId']}},
    inputSchema:z.object({bookingId:z.string().uuid()}).strict(),execute:input=>client.getStudentConsultationBooking(input.bookingId),
  },{
    definition:{name:'reviewStudentConsultationEmail',description:'Display the existing student consultation and corrected email address. Ask the user to check and explicitly confirm before resending.',parameters:{type:'object',additionalProperties:false,properties:{bookingId:{type:'string'},customerEmail:{type:'string'}},required:['bookingId','customerEmail']}},
    inputSchema:z.object({bookingId:z.string().uuid(),customerEmail:details.customerEmail}).strict(),
    execute:async(input,context)=>{const id=session(context);const result=await client.reviewStudentConsultationEmail(input);save(id,'resend',input);return result;},
  },{
    definition:{name:'resendStudentConsultationEmail',description:'Queue a corrected consultation email only after reviewStudentConsultationEmail and explicit confirmation. If sending is already in progress, ask the customer to try the correction again shortly.',parameters:{type:'object',additionalProperties:false,properties:{bookingId:{type:'string'},customerEmail:{type:'string'},confirmed:{type:'boolean'}},required:['bookingId','customerEmail','confirmed']}},
    inputSchema:z.object({bookingId:z.string().uuid(),customerEmail:details.customerEmail,confirmed:z.literal(true)}).strict(),
    execute:async(input,context)=>{
      const id=session(context);const review=pending.get(id);
      if(!review || review.mode!=='resend' || review.expiresAt<Date.now() || review.input['bookingId']!==input.bookingId || review.input['customerEmail']!==input.customerEmail)throw new Error('Review and confirm the corrected consultation email before resending');
      const result=await client.resendStudentConsultationEmail(input);
      if(pending.get(id)===review)pending.delete(id);return result;
    },
  }];
}
