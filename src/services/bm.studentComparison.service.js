import { searchKnowledge } from "./bm.studentAgency.service.js";
import { verifyStudentSources } from "./bm.studentVerification.service.js";
import { genuineStudentComparison, processingPriorityComparison, reviewedStudentCard } from "./bm.studentCards.service.js";

export async function compareStudentRules(companyId, input = {}, { verify = verifyStudentSources, search = searchKnowledge } = {}) {
  const baselineDate = input.baselineDate;
  if (baselineDate != null && (typeof baselineDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(baselineDate) ||
      !Number.isFinite(Date.parse(baselineDate)) || new Date(baselineDate).toISOString().slice(0,10) !== baselineDate || Date.parse(baselineDate) > Date.now())) {
    const error = new Error("baselineDate must be a valid date in the past or today");error.status=400;throw error;
  }
  const evidence = await verify({topic: input.topic});
  let reviewed = {results: []};
  try { reviewed = await search(companyId, {q: input.topic.replaceAll("_", " ")}); } catch { /* Live evidence can still support a comparison. */ }
  const comparison = { genuine_student: genuineStudentComparison, processing_priorities: processingPriorityComparison }[input.topic];
  const live = comparison?.(evidence.sources);
  // When live GS content no longer supports the known transition, do not revive
  // it from an older reviewed record as if current. Other topics remain dated.
  let cards = comparison ? (live ? [live] : []) : reviewed.results
    .filter(r => r.topic === input.topic && r.previousRule && r.currentRule).map(reviewedStudentCard);
  if (baselineDate) cards = cards.filter(c => c.effectiveFrom && String(c.effectiveFrom).slice(0,10) >= baselineDate);
  return {...evidence, baselineDate: baselineDate || null,
    comparisonStatus: cards.length ? "supported_comparison" : "comparison_unavailable",
    studentView: {title:"What changed?", cards, notice: cards.length
      ? "Only supported changes are shown. This is not a complete history; dates and circumstances determine which rules apply."
      : "We could not establish a previous-versus-current rule comparison for this topic and period. This does not mean no rules changed."},
    questionsToClarify:["Are you applying for a new visa or asking about a visa already granted?", "When was, or will, the application be lodged?", "Are you inside or outside Australia, and what course are you studying?"],
    guidance: `${evidence.guidance} Use the studentView comparison exactly within its stated scope. Do not fill missing impacts or historical rules from memory. Announced changes are not yet in force. Ask only the contextual questions relevant to the user's request.`,
  };
}
