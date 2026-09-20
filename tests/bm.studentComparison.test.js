import { expect, it, jest } from "@jest/globals";
jest.unstable_mockModule("../src/models/bm.studentAgency.model.js",()=>({searchStudentKnowledge:jest.fn()}));
jest.unstable_mockModule("../src/models/bm.studentSourceSnapshots.model.js",()=>({}));
const {compareStudentRules}=await import("../src/services/bm.studentComparison.service.js");
const {genuineStudentComparison,reviewedStudentCard,evidenceStudentView}=await import("../src/services/bm.studentCards.service.js");
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

const prioritySource = {...source,sourceId:"processing_priorities",text:"Applications lodged by students outside Australia. For applications lodged before 14 November 2025, these priorities are outlined in Ministerial Direction 111. For applications lodged on or after 14 November 2025, these priorities are outlined in Ministerial Direction 115. A Ministerial Direction is not a visa cap, and it does not set the criteria to approve or refuse a student visa application."};
it("compares MD111 and MD115 using the actual commencement rather than checking date",async()=>{
  const result=await compareStudentRules("company",{topic:"processing_priorities",baselineDate:"2025-01-01"},deps([prioritySource]));
  expect(result.studentView.cards[0]).toMatchObject({effectiveFrom:"2025-11-14",evidenceStatus:"live"});
  expect(result.studentView.cards[0].currentStudentImpact).toContain("already-granted");
});
it("does not resurrect an unsupported, truncated or unavailable priority comparison",async()=>{
  for (const altered of [{text:"MD115 replaces MD111"},{truncated:true},{status:"unavailable"}]) {
    const result=await compareStudentRules("company",{topic:"processing_priorities"},deps([{...prioritySource,...altered}],[{topic:"processing_priorities",previousRule:"old",currentRule:"new"}]));
    expect(result.comparisonStatus).toBe("comparison_unavailable");
  }
});
it("keeps MD115 cache dates and respects a 2026-only comparison period",async()=>{
  const cached=await compareStudentRules("company",{topic:"processing_priorities"},deps([{...prioritySource,status:"cached"}]));
  expect(cached.studentView.cards[0].evidenceStatus).toBe("cached");
  const later=await compareStudentRules("company",{topic:"processing_priorities",baselineDate:"2026-01-01"},deps([prioritySource]));
  expect(later.studentView.cards).toHaveLength(0);
});
it("keeps family evidence visible alongside a GS comparison",()=>{
  const family={sourceId:"family",status:"unavailable",title:"Family declarations",url:"https://immi.homeaffairs.gov.au/visas/bringing-someone/bringing-partner-or-family"};
  const view=evidenceStudentView({sources:[source,family]});
  expect(view.cards).toHaveLength(2);
  expect(view.cards[1]).toMatchObject({title:"Family declarations",evidenceStatus:"unavailable"});
});
