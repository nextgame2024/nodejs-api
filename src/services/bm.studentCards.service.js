import { isOfficialStudentUrl } from "./bm.studentSources.js";

const dateOnly = value => value instanceof Date ? value.toISOString().slice(0,10) : value || null;
const text = value => typeof value === "string" ? value.trim() : "";
export function cardSources(sources = [], verifiedAt) {
  return sources.filter(s => s && isOfficialStudentUrl(s.url)).map(s => ({
    title: text(s.title) || "Official source", url: s.url,
    checkedAt: s.fetchedAt || verifiedAt || null,
    status: s.status === "fetched" ? "live" : s.status === "cached" ? "cached" : s.status === "unavailable" ? "unavailable" : "reviewed",
  }));
}
export function reviewedStudentCard(record) {
  const comparison = !!(text(record.previousRule) && text(record.currentRule));
  return {
    kind: comparison ? "comparison" : "answer", title: record.question, summary: record.answer,
    evidenceStatus: "reviewed", verifiedAt: record.verifiedAt || null,
    previousRule: record.previousRule || null, currentRule: record.currentRule || null,
    newStudentImpact: record.newStudentImpact || null, currentStudentImpact: record.currentStudentImpact || null,
    effectiveFrom: dateOnly(record.effectiveFrom), effectiveTo: dateOnly(record.effectiveTo),
    changeStatus: record.changeStatus || "general",
    applicability: Object.entries(record.applicability || {}).filter(([,v]) => typeof v === "string").map(([k,v]) => `${k}: ${v}`),
    sources: cardSources(record.sources, record.verifiedAt),
    limitations: ["Reviewed information is dated; it does not establish that no newer changes exist."],
  };
}
export function knowledgeStudentView(results) {
  return { title: "Student guidance", cards: results.map(reviewedStudentCard),
    notice: results.length ? "Source dates are shown with each answer." : "No reviewed answer is available yet. Sophia can check the official sources for your topic." };
}

// A narrow source-backed example, not a general legal-rule parser. Both exact
// statements must still appear in the fetched/cached official page before use.
export function genuineStudentComparison(sources) {
  const source = sources.find(s => s.sourceId === "genuine_student" && ["fetched", "cached"].includes(s.status) && !s.truncated);
  const evidence = text(source?.text).replace(/\s+/g," ").replace(/\s+([.,;:])/g,"$1").toLowerCase();
  if (!evidence.includes("the genuine student (gs) requirement applies to student visa applications lodged on or after 23 march 2024.") ||
      !evidence.includes("we will assess applications lodged before this date under the genuine temporary entrant (gte) requirement.")) return null;
  return {
    kind: "comparison", title: "GTE → Genuine Student", summary: "The applicable requirement is determined by when the student visa application was lodged.",
    previousRule: "Genuine Temporary Entrant (GTE): applications lodged before 23 March 2024.",
    currentRule: "Genuine Student (GS): applications lodged on or after 23 March 2024.",
    newStudentImpact: "For a new application lodged from the effective date, the GS requirement applies.",
    currentStudentImpact: "Current enrolment alone does not determine the rule. For another application, check its lodgement date. This comparison does not establish changes to an already-granted visa.",
    effectiveFrom: "2024-03-23", effectiveTo: null, changeStatus: "in_force",
    applicability: ["Student visa applications; application lodgement date is the dividing point."],
    evidenceStatus: source.status === "fetched" ? "live" : "cached", verifiedAt: source.fetchedAt,
    sources: cardSources([source]),
    limitations: ["This is one documented change, not a complete list of recent changes or an assessment of individual eligibility."],
  };
}
export function evidenceStudentView(result) {
  const comparisons = [genuineStudentComparison(result.sources), processingPriorityComparison(result.sources)].filter(Boolean);
  const comparedUrls = new Set(comparisons.flatMap(card => card.sources.map(source => source.url)));
  return {title: "Official student information", notice: "Official pages support the answer only where they address your question. Missing details still need verification.",
    cards: [...comparisons, ...result.sources.filter(source => !comparedUrls.has(source.url)).map(source => ({
      kind: "evidence", title: source.title,
      summary: source.status === "fetched" ? "Official page retrieved for this topic. Sophia will explain the relevant supported information." : source.status === "cached" ? "A saved copy is available. The official page could not be checked live." : "This official page could not be checked. Its current requirements remain unverified.",
      evidenceStatus: source.status === "fetched" ? "live" : source.status === "cached" ? "cached" : "unavailable",
      verifiedAt: source.fetchedAt || null, sources: cardSources([source]), applicability: [],
      limitations: source.truncated ? ["The retrieved page is incomplete; missing details need verification."] : [],
    }))]};
}

export function processingPriorityComparison(sources) {
  const source = sources.find(s => s.sourceId === "processing_priorities" && ["fetched", "cached"].includes(s.status) && !s.truncated);
  const evidence = text(source?.text).replace(/\s+/g, " ").toLowerCase();
  // Require the date, scope and direction together; isolated mentions are not proof.
  if (!evidence.includes("applications lodged by students outside australia") ||
      !/for applications lodged before 14 november 2025, these priorities are outlined in ministerial direction 111/.test(evidence) ||
      !/for applications lodged on or after 14 november 2025, these priorities are outlined in ministerial direction 115/.test(evidence) ||
      !evidence.includes("it does not set the criteria to approve or refuse a student visa application")) return null;
  return {
    kind: "comparison", title: "Offshore processing: MD111 → MD115",
    summary: "The offshore lodgement date determines the processing direction; priority does not decide eligibility or approval.",
    previousRule: "MD111 applies to offshore applications lodged before 14 November 2025 within the scope described by this source.",
    currentRule: "MD115 applies to offshore applications lodged on or after 14 November 2025.",
    newStudentImpact: "Check the application lodgement date, offshore status and relevant priority category.",
    currentStudentImpact: "This concerns application processing, not new conditions on an already-granted visa. Check pending or further applications separately.",
    effectiveFrom: "2025-11-14", effectiveTo: null, changeStatus: "in_force",
    applicability: ["Offshore Subclass 500 processing; not a visa cap or guaranteed decision time."],
    evidenceStatus: source.status === "fetched" ? "live" : "cached", verifiedAt: source.fetchedAt,
    sources: cardSources([source]), limitations: ["This is a bounded comparison, not a complete history of student visa changes."],
  };
}
