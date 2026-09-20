import { jest } from "@jest/globals";
import { createStudentAgencyTools } from "./student-agency.tools.js";
import type { BusinessManagerClient } from "../real-estate/business-manager.client.js";
import { ToolRegistry } from "../tool-registry.js";
import type { BusinessResearchService } from "../research/business-research.service.js";

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
  const tool = createStudentAgencyTools({searchStudentAgencyKnowledge: search} as unknown as BusinessManagerClient)[0]!;
  expect(await tool.execute({q: "visa requirements"}, {customerId: "demo"})).toMatchObject({status: "unavailable", results: [], consultationBookingRequiresAvailabilityCheck: true, liveVerified: false});
});

it("automatically researches official sources when reviewed knowledge is empty", async () => {
  const search = jest.fn<BusinessManagerClient["searchStudentAgencyKnowledge"]>().mockResolvedValue({domain:"student_migration",results:[]});
  const official = jest.fn().mockResolvedValue({domain:"student_migration",status:"official_evidence",sourceMode:"official_web_research",summary:"Official answer",sources:[{url:"https://immi.homeaffairs.gov.au/example"}]});
  const research = {researchOfficialStudentInformation:official} as unknown as BusinessResearchService;
  const tool=createStudentAgencyTools({searchStudentAgencyKnowledge:search} as unknown as BusinessManagerClient,research)[0]!;
  expect(await tool.execute({q:"An uncovered question"},{customerId:"demo"})).toMatchObject({status:"official_evidence"});
  expect(official).toHaveBeenCalledWith("An uncovered question");
});

it("does not call web research when reviewed knowledge contains an answer", async () => {
  const search = jest.fn<BusinessManagerClient["searchStudentAgencyKnowledge"]>().mockResolvedValue({domain:"student_migration",results:[{answer:"Reviewed"}]});
  const official = jest.fn();
  const tool=createStudentAgencyTools({searchStudentAgencyKnowledge:search} as unknown as BusinessManagerClient,{researchOfficialStudentInformation:official} as unknown as BusinessResearchService)[0]!;
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
  const tool=createStudentAgencyTools({verifyStudentRules:verify} as unknown as BusinessManagerClient)[1]!;
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
