import crypto from "node:crypto";
import { isOfficialStudentUrl } from "./bm.studentSources.js";

export function validateStudentContent(pack, { approve = false, reviewer, now = Date.now() } = {}) {
  if (!Array.isArray(pack?.records) || !pack.records.length || pack.records.length > 100) throw new Error("Provide 1–100 content records");
  const keys = new Set();
  return pack.records.map(record => {
    for (const key of ["key", "topic", "question", "answer"]) {
      if (typeof record[key] !== "string" || !record[key].trim() || record[key].length > 8000) throw new Error(`Invalid ${key}`);
    }
    for (const key of ["previousRule", "currentRule", "newStudentImpact", "currentStudentImpact"]) {
      if (record[key] != null && (typeof record[key] !== "string" || record[key].length > 8000)) throw new Error(`Invalid ${key}`);
    }
    if (record.applicability != null && (typeof record.applicability !== "object" || Array.isArray(record.applicability))) throw new Error("Invalid applicability");
    if (keys.has(record.key)) throw new Error("Duplicate content key");
    keys.add(record.key);
    if (!Array.isArray(record.sources) || !record.sources.length || record.sources.length > 8 ||
        record.sources.some(s => !s || !isOfficialStudentUrl(s.url) || typeof s.title !== "string" || !s.title.trim())) throw new Error("Every record needs official sources");
    if (approve && (typeof reviewer !== "string" || !reviewer.trim())) throw new Error("Approval requires a named reviewer");
    const verified = new Date(record.verifiedAt).getTime();
    const due = new Date(record.reviewDueAt).getTime();
    if (approve && (!record.verifiedAt || !record.reviewDueAt || !Number.isFinite(verified) || verified > now || now - verified > 7*86400000 ||
        !Number.isFinite(due) || due <= now || due <= verified || due - verified > 7*86400000 ||
        record.sources.some(s => typeof s.excerpt !== "string" || !s.excerpt.trim()))) {
      throw new Error("Approval requires source excerpts, verification within 7 days and a review deadline within 7 days of verification");
    }
    const status = record.changeStatus || "general";
    if (!["general", "announced", "in_force", "superseded"].includes(status)) throw new Error("Invalid changeStatus");
    for (const key of ["effectiveFrom", "effectiveTo"]) {
      if (record[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(record[key]) || new Date(record[key]).toISOString().slice(0,10) !== record[key])) throw new Error(`Invalid ${key}`);
    }
    if (record.effectiveTo && record.effectiveFrom && record.effectiveTo < record.effectiveFrom) throw new Error("Invalid effective date range");
    if (approve && status === "in_force" && (!record.effectiveFrom || new Date(record.effectiveFrom).getTime() > now)) throw new Error("An in-force change requires a past effective date");
    const normalized = { ...record, changeStatus: status };
    return { ...normalized, revisionHash: crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
  });
}

export async function importStudentContent(client, companyId, records, { approve = false, reviewer } = {}) {
  // One transaction owned by the caller; serialize publication for this company.
  const company = await client.query("SELECT company_id FROM bm_company WHERE company_id=$1 FOR UPDATE", [companyId]);
  if (!company.rows.length) throw new Error("Company not found");
  for (const r of records) {
    if (approve) await client.query(`UPDATE bm_student_agency_knowledge SET publication_status='withdrawn', updated_at=now()
      WHERE company_id=$1 AND content_key=$2 AND publication_status='approved' AND revision_hash<>$3`, [companyId, r.key, r.revisionHash]);
    await client.query(`INSERT INTO bm_student_agency_knowledge
      (company_id,content_key,revision_hash,topic,question,answer,previous_rule,current_rule,new_student_impact,current_student_impact,
       applicability,change_status,effective_from,effective_to,sources,publication_status,reviewed_by,verified_at,review_due_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT(company_id,content_key,revision_hash) DO UPDATE SET
        publication_status=CASE WHEN EXCLUDED.publication_status='approved' THEN 'approved' ELSE bm_student_agency_knowledge.publication_status END,
        reviewed_by=COALESCE(EXCLUDED.reviewed_by,bm_student_agency_knowledge.reviewed_by),
        verified_at=COALESCE(EXCLUDED.verified_at,bm_student_agency_knowledge.verified_at),
        review_due_at=COALESCE(EXCLUDED.review_due_at,bm_student_agency_knowledge.review_due_at), updated_at=now()`,
    [companyId,r.key,r.revisionHash,r.topic,r.question,r.answer,r.previousRule||null,r.currentRule||null,r.newStudentImpact||null,r.currentStudentImpact||null,
      r.applicability||{},r.changeStatus,r.effectiveFrom||null,r.effectiveTo||null,JSON.stringify(r.sources),approve ? "approved" : "draft",
      approve ? reviewer.trim() : null,approve ? r.verifiedAt : null,approve ? r.reviewDueAt : null]);
  }
}
