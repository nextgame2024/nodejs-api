import { jest } from "@jest/globals";
import { createStudentAgencyTools } from "./student-agency.tools.js";
import type { BusinessManagerClient } from "../real-estate/business-manager.client.js";
import { ToolRegistry } from "../tool-registry.js";
import type { BusinessResearchService } from "../research/business-research.service.js";
const toolNamed=(tools:ReturnType<typeof createStudentAgencyTools>,name:string)=>tools.find(tool=>tool.definition.name===name)!;

it.each([
  ["documents","Documents for a student visa"],
  ["recent_changes","Recent student visa changes"],
  ["new_applicant","Effect on a new applicant"],
  ["current_student","Effect on a current student"],
  ["work","Working while studying"],
] as const)("returns a distinct reviewed panel for %s",async(intent,title)=>{
  const tool=toolNamed(createStudentAgencyTools({} as BusinessManagerClient),"showStudentVisaDemoGuidance");
  const result=await tool.execute({intent},{customerId:"demo"}) as any;
  expect(result).toMatchObject({status:"reviewed",studentView:{title}});
  expect(result.answer).toBeTruthy();
  expect(result.studentView.cards.length).toBeGreaterThan(0);
});

it("includes family and subsequent-entrant changes in the reviewed recent-changes answer",async()=>{
  const tool=toolNamed(createStudentAgencyTools({} as BusinessManagerClient),"showStudentVisaDemoGuidance");
  const result=await tool.execute({intent:"recent_changes"},{customerId:"demo"}) as any;
  expect(result.answer).toContain("minor child is Priority 1");
  expect(result.answer).toContain("without a minor child is Priority 2");
  expect(result.studentView.cards).toEqual(expect.arrayContaining([
    expect.objectContaining({title:"Applying with family and subsequent entrants",effectiveFrom:"2025-11-14"}),
  ]));
});

it("routes student enquiries through the separate endpoint", async () => {
  const search = jest.fn<BusinessManagerClient["searchStudentAgencyKnowledge"]>().mockResolvedValue({ domain: "student_migration", results: [] });
  const registry = new ToolRegistry();
  for (const tool of createStudentAgencyTools({searchStudentAgencyKnowledge: search} as unknown as BusinessManagerClient)) registry.register(tool);
  await registry.execute("searchStudentAgencyKnowledge", {q: "What changed for current students?"}, {customerId: "demo"});
  expect(search).toHaveBeenCalledWith({q: "What changed for current students?"});
  await expect(registry.execute("searchStudentAgencyKnowledge", {q: "visa", propertyId: "wrong-domain"}, {customerId: "demo"})).rejects.toThrow();
});
it("returns unavailable without inventing rules or using rental fallbacks", async () => {
  const search = jest.fn<BusinessManagerClient["searchStudentAgencyKnowledge"]>().mockRejectedValue(new Error("offline"));
  const tool = toolNamed(createStudentAgencyTools({searchStudentAgencyKnowledge: search} as unknown as BusinessManagerClient),"searchStudentAgencyKnowledge");
  expect(await tool.execute({q: "visa requirements"}, {customerId: "demo"})).toMatchObject({status: "unavailable", results: [], consultationBookingRequiresAvailabilityCheck: true, liveVerified: false});
});

it("automatically researches official sources when reviewed knowledge is empty", async () => {
  const search = jest.fn<BusinessManagerClient["searchStudentAgencyKnowledge"]>().mockResolvedValue({domain:"student_migration",results:[]});
  const official = jest.fn().mockResolvedValue({domain:"student_migration",status:"official_evidence",sourceMode:"official_web_research",summary:"Official answer",sources:[{url:"https://immi.homeaffairs.gov.au/example"}]});
  const research = {researchOfficialStudentInformation:official} as unknown as BusinessResearchService;
  const tool=toolNamed(createStudentAgencyTools({searchStudentAgencyKnowledge:search} as unknown as BusinessManagerClient,research),"searchStudentAgencyKnowledge");
  expect(await tool.execute({q:"An uncovered question"},{customerId:"demo"})).toMatchObject({status:"official_evidence"});
  expect(official).toHaveBeenCalledWith("An uncovered question");
});

it("does not call web research when reviewed knowledge contains an answer", async () => {
  const search = jest.fn<BusinessManagerClient["searchStudentAgencyKnowledge"]>().mockResolvedValue({domain:"student_migration",results:[{answer:"Reviewed"}]});
  const official = jest.fn();
  const tool=toolNamed(createStudentAgencyTools({searchStudentAgencyKnowledge:search} as unknown as BusinessManagerClient,{researchOfficialStudentInformation:official} as unknown as BusinessResearchService),"searchStudentAgencyKnowledge");
  expect(await tool.execute({q:"A reviewed question"},{customerId:"demo"})).toMatchObject({results:[{answer:"Reviewed"}]});
  expect(official).not.toHaveBeenCalled();
});

it("exposes official verification without allowing caller-supplied source URLs", async () => {
  const verify = jest.fn<BusinessManagerClient["verifyStudentRules"]>().mockResolvedValue({status:"official_evidence",sources:[]});
  const registry = new ToolRegistry();
  for (const tool of createStudentAgencyTools({verifyStudentRules:verify} as unknown as BusinessManagerClient)) registry.register(tool);
  await registry.execute("verifyStudentRules",{topic:"genuine_student"},{customerId:"demo"});
  expect(verify).toHaveBeenCalledWith({topic:"genuine_student"});
  await expect(registry.execute("verifyStudentRules",{topic:"work",url:"https://evil.test"},{customerId:"demo"})).rejects.toThrow();
});
it("does not claim live evidence when the verification endpoint fails", async () => {
  const verify=jest.fn<BusinessManagerClient["verifyStudentRules"]>().mockRejectedValue(new Error("timeout"));
  const tool=toolNamed(createStudentAgencyTools({verifyStudentRules:verify} as unknown as BusinessManagerClient),"verifyStudentRules");
  expect(await tool.execute({topic:"work"},{customerId:"demo"})).toMatchObject({status:"verification_unavailable",sources:[]});
});

it("offers comparisons and rejects unknown fields",async()=>{
  const compare=jest.fn<BusinessManagerClient["compareStudentRules"]>().mockResolvedValue({comparisonStatus:"supported_comparison"});
  const registry=new ToolRegistry();
  for(const tool of createStudentAgencyTools({compareStudentRules:compare} as unknown as BusinessManagerClient))registry.register(tool);
  await registry.execute("compareStudentRules",{topic:"genuine_student",baselineDate:"2024-01-01"},{customerId:"demo"});
  expect(compare).toHaveBeenCalledWith({topic:"genuine_student",baselineDate:"2024-01-01"});
  expect(await registry.execute("closeStudentView",{},{customerId:"demo"})).toEqual({closeStudentView:true});
});
