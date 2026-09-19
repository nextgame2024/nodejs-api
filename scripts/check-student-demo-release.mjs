import 'dotenv/config';
import pool from '../src/config/db.js';
import {searchProperties,listInspectionSlots} from '../src/services/bm.realEstate.service.js';
import {listConsultations} from '../src/services/bm.studentConsultation.service.js';
import {compareStudentRules} from '../src/services/bm.studentComparison.service.js';
import {verifyStudentSources} from '../src/services/bm.studentVerification.service.js';
const companyId=process.argv.find(arg=>arg.startsWith('--company-id='))?.split('=')[1];
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId||''))throw new Error('Specify --company-id');
// Refreshes only existing demo calendars and official-source snapshots. Never
// books, sends email, publishes drafts, or processes an existing delivery queue.
try {
 const report={checkedAt:new Date().toISOString(),properties:{},sources:[],deployment:{}};
 for(const listingType of ['rent','sale']){
  const properties=await searchProperties(companyId,{listingType,city:'Brisbane',limit:3});
  report.properties[listingType]=await Promise.all(properties.map(async p=>({propertyId:p.propertyId,address:p.address,availableSlots:(await listInspectionSlots(companyId,p.propertyId)).length})));
 }
 report.consultations=(await listConsultations(companyId)).consultationSlots.map(s=>({startsAt:s.startsAt,isDemo:s.isDemo}));
 for(const topic of ['genuine_student','documents','work']){
  const evidence=topic==='genuine_student'?await compareStudentRules(companyId,{topic}):await verifyStudentSources({topic});
  report.sources.push({topic,status:evidence.status,comparisonStatus:evidence.comparisonStatus,sources:evidence.sources.map(s=>({url:s.url,status:s.status,fetchedAt:s.fetchedAt,historySaved:s.historySaved}))});
 }
 for(const [name,url] of Object.entries({backendStudent:'https://nodejs-api-hft7.onrender.com/api/bm/student-agency/consultation-slots',backendProperty:'https://nodejs-api-hft7.onrender.com/api/bm/real-estate/properties',frontend:'https://sophiaai.com.au/sophia'})){
  try {const r=await fetch(url,{signal:AbortSignal.timeout(15000)});await r.body?.cancel();report.deployment[name]={status:r.status};}
  catch {report.deployment[name]={status:'unreachable'};}
 }
 report.deployment.studentRoutePresent=report.deployment.backendStudent.status===401;
 console.log(JSON.stringify(report,null,2));
 if(process.argv.includes('--require-deployed') && !report.deployment.studentRoutePresent)process.exitCode=1;
 if(Object.values(report.properties).some(rows=>rows.length<1||rows.some(r=>!r.availableSlots))||!report.consultations.length)process.exitCode=1;
}finally{await pool.end();}
