import crypto from 'node:crypto';
import * as emailModel from '../models/bm.studentConsultationEmail.model.js';
import {sendStudentConsultationEmail} from './bm.studentConsultationEmail.service.js';
import {ensureStudentConsultationSchema} from '../config/studentConsultationSchema.js';
const workerId=`${process.pid}:${crypto.randomUUID()}`;
export async function processStudentConsultationEmailCycle({model=emailModel,sendEmail=sendStudentConsultationEmail,id=workerId}={}) {
  const lock=await model.acquireLock();
  if(!lock)return {status:'lock_busy'};
  try {
    const booking=await model.claimEmail(id);
    if(!booking)return {status:'idle'};
    try {
      const status=await sendEmail(booking);
      if(!['sent','logged'].includes(status))throw new Error('Email provider did not confirm acceptance');
      await model.finishEmail(booking.deliveryId,id,status);
      return {status,deliveryId:booking.deliveryId};
    }catch(error){
      const status=await model.failEmail(booking.deliveryId,id,String(error.message||error));
      return {status,deliveryId:booking.deliveryId};
    }
  }finally{await lock.release();}
}
export function startStudentConsultationWorkflow({ensureSchema=ensureStudentConsultationSchema,cycle=processStudentConsultationEmailCycle,logger=console,intervalMs=15000}={}) {
  let stopped=false;let timer;let wake;
  const wait=()=>new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,intervalMs);});
  const done=(async()=>{
    let ready=false;
    while(!stopped) {
      try {
        if(!ready){await ensureSchema();ready=true;logger.log('[STUDENT_CONSULTATION] Email worker started');}
        if(stopped)break;
        const result=await cycle();
        if(!['idle','lock_busy'].includes(result.status))logger.log('[STUDENT_CONSULTATION]',result);
        if(['sent','logged'].includes(result.status))continue;
      }catch(error){logger.error('[STUDENT_CONSULTATION] Worker cycle failed:',error.message);}
      if(!stopped)await wait();
    }
  })();
  return {done,stop:async()=>{stopped=true;clearTimeout(timer);wake?.();await done;}};
}
