import fs from "node:fs";
import { expect, it, jest } from "@jest/globals";
import { validateStudentContent, importStudentContent } from "../src/services/bm.studentContentImport.service.js";
const now=Date.parse("2026-09-19T01:00:00Z");
const record={key:"test",topic:"work",question:"Example question",answer:"Example answer",sources:[{title:"Official source",url:"https://www.education.gov.au/example",excerpt:"Reviewed supporting extract"}],verifiedAt:"2026-09-19T00:00:00Z",reviewDueAt:"2026-09-20T00:00:00Z"};
it("validates 20 draft FAQs but refuses to label them approved",()=>{
  const pack=JSON.parse(fs.readFileSync("data/student-agency/faqs.draft.json","utf8"));
  expect(validateStudentContent(pack)).toHaveLength(20);
  expect(()=>validateStudentContent(pack,{approve:true,reviewer:"Agency reviewer",now})).toThrow("Approval requires");
});
it("requires a real review identity, recent dates and source excerpts for approval",()=>{
  expect(()=>validateStudentContent({records:[record]},{approve:true,now})).toThrow("named reviewer");
  expect(validateStudentContent({records:[record]},{approve:true,reviewer:"Agency reviewer",now})).toHaveLength(1);
  expect(()=>validateStudentContent({records:[{...record,reviewDueAt:"2026-10-01"}]},{approve:true,reviewer:"Reviewer",now})).toThrow();
});
it("rejects unsupported sources, duplicates and future in-force dates",()=>{
  expect(()=>validateStudentContent({records:[{...record,sources:[{url:"https://evil.test",title:"Fake"}]}]})).toThrow("official sources");
  expect(()=>validateStudentContent({records:[record,record]})).toThrow("Duplicate");
  expect(()=>validateStudentContent({records:[{...record,changeStatus:"in_force",effectiveFrom:"2099-01-01"}]},{approve:true,reviewer:"Reviewer",now})).toThrow("past effective");
});
it("imports drafts without withdrawing an existing published answer",async()=>{
  const query=jest.fn().mockResolvedValue({rows:[{company_id:"company"}]});
  await importStudentContent({query},"company",validateStudentContent({records:[record]}));
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1][1][15]).toBe("draft");
  expect(query.mock.calls[1][1][16]).toBeNull();
});
