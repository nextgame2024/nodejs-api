const home = "https://immi.homeaffairs.gov.au";
export const STUDENT_SOURCES = Object.freeze({
  application: { title: "Home Affairs — Applying for a student visa", url: `${home}/check-twice-submit-once/student-visa`, marker: "Applying for a student visa" },
  checklist: { title: "Home Affairs — Document Checklist Tool", url: `${home}/visas/web-evidentiary-tool`, marker: "Document Checklist Tool" },
  genuine_student: { title: "Home Affairs — Genuine Student requirement", url: `${home}/visas/getting-a-visa/visa-listing/student-500/genuine-student-requirement`, marker: "Genuine Student requirement" },
  work: { title: "Department of Education — International students at work", url: "https://www.education.gov.au/international-education/support-international-students/rights-international-students-work", marker: "international students" },
  changes: { title: "Home Affairs — Changes in your situation", url: `${home}/change-in-situation`, marker: "your visa might be affected", minTextLength: 200 },
  duration: { title: "Home Affairs — Length of stay", url: `${home}/visas/getting-a-visa/visa-listing/student-500/length-of-stay`, marker: "Length of stay" },
  advisers: { title: "OMARA — Getting help from someone who is not registered", url: "https://www.mara.gov.au/get-help-with-a-visa/helpers-not-registered", marker: "immigration assistance" },
});
export const STUDENT_TOPICS = Object.freeze({
  general: ["application", "checklist"],
  duration: ["duration"],
  documents: ["checklist", "application"],
  genuine_student: ["genuine_student"],
  english: ["checklist"],
  finances: ["checklist"],
  health_cover: ["checklist"],
  work: ["work"],
  dependants: ["checklist"],
  course_changes: ["changes", "application"],
  advisers: ["advisers"],
});
const hosts = new Set(["immi.homeaffairs.gov.au", "www.homeaffairs.gov.au", "www.education.gov.au", "www.studyaustralia.gov.au", "www.legislation.gov.au", "www.mara.gov.au"]);
export function isOfficialStudentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && hosts.has(url.hostname);
  } catch { return false; }
}
