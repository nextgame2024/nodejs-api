import { documentExtraction,validateDocument } from './student-document-analysis.contracts.js';

export const documentWorkflowEnabled=()=>process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED==='true';

export function analysisToday(now = new Date()): string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Brisbane',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  return ['year','month','day'].map(key=>parts.find(p=>p.type===key)!.value).join('-');
}
export function analysisVerdict(row:Record<string,any>,name:string,today=analysisToday()) {
  const extraction=row.review_result_id===row.result_id?(row.corrections??row.extraction):row.extraction;
  const parsed=documentExtraction.safeParse(extraction);
  let verdict=parsed.success?validateDocument(parsed.data,name,today):null;
  const reviewed=row.review_result_id===row.result_id?row.decision:null;
  // An expired passport remains pending until reviewed and cannot be made valid by confirmation.
  const expired=parsed.success&&parsed.data.kind==='passport'&&parsed.data.expiresOn!==null&&parsed.data.expiresOn<today;
  if(expired&&reviewed==='confirmed'&&verdict)verdict={status:'invalid',reasons:[...new Set([...verdict.reasons,'passport_expired'])]};
  const normalize=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
  const identityChanged=verdict?.reasons.includes('student_identity_needs_review')&&
    normalize(row.review_context?.studentNameAtReview??'')!==normalize(name);
  let status=row.status==='queued'||row.status==='processing'?'checking':row.status==='failed'?'check_failed':
    reviewed==='rejected'||(expired&&reviewed==='confirmed')?'invalid':parsed.success?(reviewed==='confirmed'&&!identityChanged&&verdict?.status==='needs_review'?'passed':verdict?.status):'not_checked';
  return {status,parsed,verdict,reviewed};
}
