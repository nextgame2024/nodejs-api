import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.service.js';
import { caseSchema } from './student-operations-cases.service.js';
import { analysisToday,analysisVerdict } from './student-document-analysis-state.js';

export const documentChecklistEnabled=()=>process.env.STUDENT_DOCUMENT_CHECKLIST_ENABLED==='true';
export const DOCUMENT_CHECKLIST_KEYS=['signed_engagement_letter','document_completeness'] as const;
const labels={signed_engagement_letter:'Signed engagement letter',document_completeness:'Document completeness'};

export async function isLatestTypedDocument(db:PoolClient,tenant:string,id:string,documentId:string){
  return Boolean((await db.query(`SELECT d.document_id FROM ${caseSchema()}.student_operations_case_documents d
    WHERE d.customer_id=$1 AND d.case_id=$2 AND d.document_type_id=(SELECT document_type_id FROM ${caseSchema()}.student_operations_case_documents
      WHERE customer_id=$1 AND case_id=$2 AND document_id=$3)
    ORDER BY d.discovered_at DESC,d.document_id DESC LIMIT 1`,[tenant,id,documentId])).rows[0]?.document_id===documentId);
}

/** Latest typed upload wins; never fall back to an older passed document. Local data only. */
export async function documentChecklistEvidence(db:PoolClient,tenant:string,id:string,today=analysisToday()) {
  const s=caseSchema();
  const rows=(await db.query(`SELECT q.requirement_key,q.required,t.status AS type_status,
      d.document_id,j.status,j.document_kind,r.result_id,r.extraction,
      v.result_id AS review_result_id,v.review_version,v.decision,v.corrections,v.review_context,
      o.is_current AS offer_current,s.legal_name
    FROM ${s}.student_operations_cases c
    JOIN ${s}.student_operations_students s ON s.customer_id=c.customer_id AND s.student_id=c.student_id
    JOIN ${s}.student_operations_status_document_requirements q ON q.customer_id=c.customer_id AND q.case_status='pre_sale' AND q.status='active'
    JOIN ${s}.student_operations_document_types t ON t.customer_id=q.customer_id AND t.document_type_id=q.document_type_id
    LEFT JOIN LATERAL (SELECT * FROM ${s}.student_operations_case_documents d
      WHERE d.customer_id=c.customer_id AND d.case_id=c.case_id AND d.document_type_id=q.document_type_id
      ORDER BY d.discovered_at DESC,d.document_id DESC LIMIT 1) d ON true
    LEFT JOIN LATERAL (SELECT * FROM ${s}.student_document_analysis_jobs j
      WHERE j.customer_id=d.customer_id AND j.case_id=d.case_id AND j.document_id=d.document_id
      ORDER BY j.created_at DESC,j.job_id DESC LIMIT 1) j ON true
    LEFT JOIN ${s}.student_document_analysis_results r ON r.customer_id=j.customer_id AND r.job_id=j.job_id
    LEFT JOIN LATERAL (SELECT * FROM ${s}.student_document_reviews v
      WHERE v.customer_id=d.customer_id AND v.case_id=d.case_id AND v.document_id=d.document_id ORDER BY v.review_version DESC LIMIT 1) v ON true
    LEFT JOIN ${s}.student_case_offers o ON o.customer_id=c.customer_id AND o.case_id=c.case_id AND o.document_id=d.document_id AND o.result_id=r.result_id AND o.is_current
    WHERE c.customer_id=$1 AND c.case_id=$2 ORDER BY q.sort_order,q.requirement_key`,[tenant,id])).rows;
  const evidence=rows.map(row=>{
    const verdict=analysisVerdict(row,row.legal_name,today);
    const accepted=row.type_status==='active'&&row.status==='succeeded'&&row.document_kind===row.requirement_key&&
      verdict.parsed.success&&verdict.parsed.data.kind===row.requirement_key&&verdict.status==='passed'&&
      (row.requirement_key!=='letter_of_offer'||(row.offer_current===true&&verdict.reviewed==='confirmed'));
    return {key:String(row.requirement_key),required:Boolean(row.required),documentId:row.document_id??null,
      resultId:row.result_id??null,reviewVersion:row.review_version??0,accepted};
  });
  const engagement=evidence.find(e=>e.key==='engagement_letter');
  const required=evidence.filter(e=>e.required);
  return {evidence,completed:{signed_engagement_letter:Boolean(engagement?.accepted),
    document_completeness:required.length>0&&required.every(e=>e.accepted)}};
}

/** Caller holds the case lock; mutations and their audit records commit together. */
export async function reconcileDocumentChecklist(db:PoolClient,tenant:string,id:string,today=analysisToday()) {
  if(!documentChecklistEnabled())return;
  const s=caseSchema();
  const c=(await db.query(`SELECT lifecycle_status FROM ${s}.student_operations_cases WHERE customer_id=$1 AND case_id=$2`,[tenant,id])).rows[0];
  if(c?.lifecycle_status!=='pre_sale')return;
  // Replacement makes previous financial approval historical, without erasing it.
  await db.query(`UPDATE ${s}.student_case_offers o SET is_current=false,status='superseded',record_version=record_version+1
    FROM ${s}.student_operations_case_documents old
    WHERE o.customer_id=$1 AND o.case_id=$2 AND o.is_current AND old.customer_id=o.customer_id AND old.case_id=o.case_id AND old.document_id=o.document_id
      AND EXISTS(SELECT 1 FROM ${s}.student_operations_case_documents newer WHERE newer.customer_id=old.customer_id AND newer.case_id=old.case_id
        AND newer.document_type_id=old.document_type_id AND (newer.discovered_at,newer.document_id)>(old.discovered_at,old.document_id))`,[tenant,id]);
  const {evidence,completed}=await documentChecklistEvidence(db,tenant,id,today);
  const before=(await db.query(`SELECT item_key,completed FROM ${s}.student_operations_case_checklist WHERE customer_id=$1 AND case_id=$2 AND checklist_status='pre_sale'`,[tenant,id])).rows;
  const previous=(await db.query(`SELECT evidence FROM ${s}.student_document_checklist_evaluations WHERE customer_id=$1 AND case_id=$2`,[tenant,id])).rows[0];
  const wasComplete=before.length===4&&before.every(r=>r.completed);
  const activity=async(event:string,summary:string)=>db.query(`INSERT INTO ${s}.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail)
    VALUES($1,$2,'system:document-checklist',$3,$4,jsonb_build_object('actorKind','automation','actorName','SophiaAi','ruleVersion','1','evidence',$5::jsonb))`,[tenant,id,event,summary,JSON.stringify(evidence)]);
  for(const key of DOCUMENT_CHECKLIST_KEYS){
    if(Boolean(before.find(r=>r.item_key===key)?.completed)===completed[key])continue;
    await db.query(`INSERT INTO ${s}.student_operations_case_checklist(customer_id,case_id,item_key,completed,actor_identity_user_id,actor_kind,actor_name)
      VALUES($1,$2,$3,$4,'system:document-checklist','automation','SophiaAi')
      ON CONFLICT(customer_id,case_id,checklist_status,item_key) DO UPDATE SET completed=excluded.completed,
        record_version=student_operations_case_checklist.record_version+1,actor_identity_user_id=excluded.actor_identity_user_id,
        actor_kind=excluded.actor_kind,actor_name=excluded.actor_name,updated_at=now()`,[tenant,id,key,completed[key]]);
    await activity('case.checklist_item_updated',`${labels[key]} ${completed[key]?'completed':'reopened'}`);
  }
  const offerVersion=(items:typeof evidence)=>{const e=items.find(e=>e.key==='letter_of_offer');return e?[e.documentId,e.resultId,e.reviewVersion,e.accepted]:null;};
  const offerChanged=previous&&JSON.stringify(offerVersion(previous.evidence))!==JSON.stringify(offerVersion(evidence));
  if(offerChanged&&before.find(r=>r.item_key==='invoice_loo_consistency')?.completed){
    await db.query(`UPDATE ${s}.student_operations_case_checklist SET completed=false,record_version=record_version+1,
      actor_identity_user_id='system:document-checklist',actor_kind='automation',actor_name='SophiaAi',updated_at=now()
      WHERE customer_id=$1 AND case_id=$2 AND checklist_status='pre_sale' AND item_key='invoice_loo_consistency'`,[tenant,id]);
    before.find(r=>r.item_key==='invoice_loo_consistency')!.completed=false;
    await activity('case.checklist_item_updated','Invoice/LoO consistency reopened');
  }
  const allComplete=DOCUMENT_CHECKLIST_KEYS.every(key=>completed[key])&&['invoice_loo_consistency','pending_track_status'].every(key=>before.find(r=>r.item_key===key)?.completed);
  if(wasComplete!==allComplete)await activity(allComplete?'case.checklist_completed':'case.checklist_reopened',allComplete?'Checklist complete':'Checklist reopened');
  await db.query(`INSERT INTO ${s}.student_document_checklist_evaluations(customer_id,case_id,evidence) VALUES($1,$2,$3)
    ON CONFLICT(customer_id,case_id) DO UPDATE SET evidence=excluded.evidence,checked_at=now()`,[tenant,id,JSON.stringify(evidence)]);
}

/** Bounded fair cursor, normal tenant role, no providers. Other workers skip locked cases. */
export class StudentDocumentChecklistReconciler {
  constructor(private readonly database:DatabaseService){}
  async processBatch(tenant:string){
    if(!documentChecklistEnabled())return false;
    return this.database.tenantTransaction(tenant,async db=>{
      const s=caseSchema(),due=(await db.query(`SELECT c.case_id FROM ${s}.student_operations_cases c
        LEFT JOIN ${s}.student_document_checklist_evaluations e ON e.customer_id=c.customer_id AND e.case_id=c.case_id
        WHERE c.customer_id=$1 AND c.lifecycle_status='pre_sale' AND (e.checked_at IS NULL OR e.checked_at<now()-interval '15 minutes')
        ORDER BY e.checked_at NULLS FIRST,c.case_id LIMIT 20 FOR UPDATE OF c SKIP LOCKED`,[tenant])).rows;
      for(const row of due)await reconcileDocumentChecklist(db,tenant,row.case_id);
      return due.length>0;
    });
  }
}
