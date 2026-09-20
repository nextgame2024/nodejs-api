import { expect, it, jest } from "@jest/globals";
jest.unstable_mockModule("../src/models/bm.studentAgency.model.js",()=>({searchStudentKnowledge:jest.fn()}));
jest.unstable_mockModule("../src/models/bm.studentSourceSnapshots.model.js",()=>({}));
const {compareStudentRules}=await import("../src/services/bm.studentComparison.service.js");
const {genuineStudentComparison,reviewedStudentCard}=await import("../src/services/bm.studentCards.service.js");
const source={sourceId:"genuine_student",status:"fetched",title:"Home Affairs",url:"https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/student-500/genuine-student-requirement",fetchedAt:"2026-09-19T00:00:00Z",text:"The Genuine Student (GS) requirement applies to student visa applications lodged on or after 23 March 2024 . We will assess applications lodged before this date under the Genuine Temporary Entrant (GTE) requirement."};
const deps=(sources=[source],results=[])=>({verify:jest.fn().mockResolvedValue({sources,guidance:"Use evidence"}),search:jest.fn().mockResolvedValue({results})});
it("shows the evidenced transition and separates current from new students",async()=>{
  const result=await compareStudentRules("company",{topic:"genuine_student"},deps());
  const card=result.studentView.cards[0];
  expect(card.effectiveFrom).toBe("2024-03-23");
  expect(card.evidenceStatus).toBe("live");
  expect(card.newStudentImpact).toContain("new application");
  expect(card.currentStudentImpact).toContain("does not establish changes to an already-granted visa");
});
it("does not invent historical facts or reuse a stale reviewed GS comparison when live evidence changes",async()=>{
  expect(genuineStudentComparison([{...source,text:"Different guidance"}])).toBeNull();
  const result=await compareStudentRules("company",{topic:"genuine_student"},deps([{...source,text:"Changed"}],[{topic:"genuine_student",previousRule:"old",currentRule:"new"}]));
  expect(result.comparisonStatus).toBe("comparison_unavailable");
});
it("keeps cached evidence visibly dated and rejects truncated comparison evidence",()=>{
  expect(genuineStudentComparison([{...source,status:"cached"}]).evidenceStatus).toBe("cached");
  expect(genuineStudentComparison([{...source,truncated:true}])).toBeNull();
});
it("respects the requested period without interpreting no result as no changes",async()=>{
  const result=await compareStudentRules("company",{topic:"genuine_student",baselineDate:"2025-01-01"},deps());
  expect(result.studentView.cards).toHaveLength(0);
  expect(result.studentView.notice).toContain("does not mean no rules changed");
});
it("rejects invalid and future baseline dates",async()=>{
  for(const baselineDate of ["2025-02-30","2099-01-01","yesterday"]){
    await expect(compareStudentRules("company",{topic:"work",baselineDate},deps())).rejects.toMatchObject({status:400});
  }
});
it("preserves announced status and missing impacts in reviewed comparisons",async()=>{
  const record={topic:"work",question:"Example future change",answer:"Fixture",previousRule:"Old",currentRule:"Announced",changeStatus:"announced",effectiveFrom:new Date("2027-01-01"),sources:[source]};
  const result=await compareStudentRules("company",{topic:"work"},deps([], [record]));
  expect(result.studentView.cards[0]).toMatchObject({changeStatus:"announced",evidenceStatus:"reviewed",newStudentImpact:null,currentStudentImpact:null,effectiveFrom:"2027-01-01"});
  expect(reviewedStudentCard(record).sources[0].url).toBe(source.url);
});
