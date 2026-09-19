import { jest } from "@jest/globals";
import { createStudentAgencyTools } from "./student-agency.tools.js";
import type { BusinessManagerClient } from "../real-estate/business-manager.client.js";
import { ToolRegistry } from "../tool-registry.js";

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
