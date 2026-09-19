import * as model from '../models/bm.studentConsultation.model.js';
import {isOfficialStudentUrl} from './bm.studentSources.js';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const text=value=>typeof value==='string' ? value.trim() : '';
const uuid=(value)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||''))throw error('Invalid consultation identifier');return value;};
const email=value=>{const v=text(value).toLowerCase();if(v.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw error('Enter a valid email address');return v;};
export function labelConsultation(value) {
  if(!value)return null;
  const {idempotencyKey,...result}=value;
  return {...result,startsAtLabel:new Intl.DateTimeFormat('en-AU',{timeZone:value.timeZone,weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value.startsAt))};
}
export function normalizeConsultationInput(input) {
  const customerName=text(input.customerName);
  if(customerName.length<2 || customerName.length>120)throw error('Enter a name between 2 and 120 characters');
  const startsAt=new Date(input.confirmedStartsAt);
  if(!Number.isFinite(+startsAt))throw error('Choose a valid consultation time');
  if(input.includeSummary!==undefined && typeof input.includeSummary!=='boolean')throw error('Summary consent must be true or false');
  const includeSummary=input.includeSummary===true;
  const enquirySummary=includeSummary ? text(input.enquirySummary) : '';
  if(enquirySummary.length>2000)throw error('Keep the enquiry summary under 2000 characters');
  const sourceLinks=includeSummary ? input.sourceLinks||[] : [];
  if(!Array.isArray(sourceLinks) || sourceLinks.length>5 || sourceLinks.some(url=>typeof url!=='string'||!isOfficialStudentUrl(url)))throw error('Use up to five official source links');
  return {slotId:uuid(input.slotId),confirmedStartsAt:startsAt.toISOString(),customerName,customerEmail:email(input.customerEmail),includeSummary,enquirySummary,sourceLinks};
}
export async function listConsultations(companyId) {
  const slots=await model.listSlots(companyId);
  return {consultationSlots:slots.map(labelConsultation),timeZone:'Australia/Brisbane',
    message:slots.length ? 'Choose a listed time. Demo appointments do not reserve a real agent.' : 'No consultation times are currently available. Please contact the agency.'};
}
export async function reviewConsultation(companyId,input) {
  const normalized=normalizeConsultationInput(input);
  const slot=await model.getSlot(companyId,normalized.slotId);
  if(!slot || !slot.future || !slot.active || slot.status!=='open')throw error('This consultation time is unavailable',409);
  if(+new Date(slot.startsAt)!==+new Date(normalized.confirmedStartsAt))throw error('The selected consultation time changed',409);
  return {consultationReview:{...labelConsultation(slot),...normalized,mode:'new'}};
}
export async function bookConsultation(companyId,input) {
  if(input.confirmed!==true)throw error('Explicit customer confirmation is required');
  const normalized=normalizeConsultationInput(input);
  const idempotencyKey=text(input.idempotencyKey);
  if(!idempotencyKey || idempotencyKey.length>400)throw error('A valid booking request key is required');
  const booking=await model.createBooking(companyId,{...normalized,idempotencyKey});
  return {consultationBooking:labelConsultation(booking)};
}
export async function getConsultation(companyId,bookingId) {
  const booking=await model.getBooking(companyId,uuid(bookingId));
  if(!booking)throw error('Consultation booking not found',404);
  return {consultationBooking:labelConsultation(booking)};
}
export async function reviewResend(companyId,bookingId,input) {
  const {consultationBooking}=await getConsultation(companyId,bookingId);
  return {consultationReview:{...consultationBooking,customerEmail:email(input.customerEmail),mode:'resend'}};
}
export async function resendConsultation(companyId,bookingId,input) {
  if(input.confirmed!==true)throw error('Confirm the corrected recipient before sending');
  return {consultationBooking:labelConsultation(await model.queueResend(companyId,uuid(bookingId),email(input.customerEmail)))};
}
