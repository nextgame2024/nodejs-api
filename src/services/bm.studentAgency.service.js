import { knowledgeStudentView } from "./bm.studentCards.service.js";
import { searchStudentKnowledge } from "../models/bm.studentAgency.model.js";

import { isOfficialStudentUrl } from "./bm.studentSources.js";
function validSource(source) {
  return source && isOfficialStudentUrl(source.url) && typeof source.title === "string" && !!source.title.trim();
}

export async function searchKnowledge(companyId, input = {}) {
  const q = typeof input.q === "string" ? input.q.trim() : "";
  if (q.length < 2 || q.length > 500) {
    const error = new Error("q must contain between 2 and 500 characters");
    error.status = 400;
    throw error;
  }
  const records = await searchStudentKnowledge(companyId, q);
  const results = records.filter(record => Array.isArray(record.sources) &&
    record.sources.length > 0 && record.sources.every(validSource));
  return {
    domain: "student_migration",
    status: results.length ? "reviewed_knowledge" : "verification_required",
    results,
    studentView: knowledgeStudentView(results),
    liveVerified: false,
    consultationBookingRequiresAvailabilityCheck: true,
    guidance: "Use only the returned evidence and its verification date. This lookup does not establish the latest rules. Call verifyStudentRules for current requirements and changes, or when no reviewed answer is available. Do not infer individual eligibility or that existing students are exempt. If evidence is missing, explain that official verification or agent review is needed. Use getStudentConsultationSlots to check consultation availability; do not use property inspection tools.",
  };
}
