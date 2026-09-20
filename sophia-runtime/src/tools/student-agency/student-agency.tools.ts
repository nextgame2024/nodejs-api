import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";
import type { BusinessManagerClient } from "../real-estate/business-manager.client.js";
import type { BusinessResearchService } from "../research/business-research.service.js";

const reviewedAt = "2026-09-20T11:22:49.811Z";
const source = (title:string,url:string) => ({title,url,checkedAt:reviewedAt,status:"reviewed"});
const common = {kind:"guidance",evidenceStatus:"reviewed",verifiedAt:reviewedAt,previousRule:null,currentRule:null,
  newStudentImpact:null,currentStudentImpact:null,effectiveFrom:null,effectiveTo:null,changeStatus:"general",applicability:[],limitations:[]};
const demoGuidance = {
  documents:{
    answer:"The exact document list depends on your circumstances, so use the Home Affairs Document Checklist Tool. You will usually need your passport and identity documents, Confirmation of Enrolment, Genuine Student answers and evidence, plus any required English, financial, health-cover, academic, health, character and family documents.",
    studentView:{title:"Documents for a student visa",notice:"Use the personalised Home Affairs checklist before lodging the application.",cards:[{...common,title:"Documents commonly required",summary:"Passport and identity documents; Confirmation of Enrolment; Genuine Student answers and supporting evidence; English-language and financial evidence when required; Overseas Student Health Cover; academic transcripts, qualifications and relevant employment history; and health or character documents when requested. Family applications may also need relationship, birth, schooling, consent or custody evidence.",sources:[source("Home Affairs — Document Checklist Tool","https://immi.homeaffairs.gov.au/visas/web-evidentiary-tool")]}]},
  },
  recent_changes:{
    answer:"Important recent changes include the Genuine Student requirement, which replaced GTE for applications lodged from 23 March 2024, and Ministerial Direction 115, which changed offshore processing priorities from 14 November 2025. Under MD115, an offshore subsequent-entrant application that includes a minor child is Priority 1, while one without a minor child is Priority 2. Priority affects processing order, not eligibility or approval. Eligible partners and dependent children can still apply as secondary applicants, but family members must meet their requirements and should be declared before a later subsequent-entrant application.",
    studentView:{title:"Recent student visa changes",notice:"These changes have different commencement dates and effects.",cards:[
      {...common,kind:"comparison",title:"Genuine Student requirement",summary:"The Genuine Student requirement applies by application lodgement date.",previousRule:"Genuine Temporary Entrant requirement.",currentRule:"Genuine Student requirement. Study must be the primary reason for the visa; a future intention to seek permanent residence does not by itself count against the applicant.",newStudentImpact:"Applications lodged on or after 23 March 2024 use the Genuine Student requirement.",currentStudentImpact:"An already-granted visa is not automatically changed. A later application uses the rules applying when it is lodged.",effectiveFrom:"2024-03-23",changeStatus:"in_force",sources:[source("Home Affairs — Genuine Student requirement","https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/student-500/genuine-student-requirement")]},
      {...common,kind:"comparison",title:"Offshore processing priorities",summary:"Ministerial Direction 115 changed the processing framework for relevant offshore applications.",previousRule:"MD111 used two processing-priority levels.",currentRule:"MD115 uses three processing-priority levels. Priority affects processing order, not eligibility, approval or a guaranteed decision time.",newStudentImpact:"For offshore applications lodged on or after 14 November 2025, the provider and applicant category can affect processing priority.",currentStudentImpact:"An already-granted visa is not reassessed because the processing-priority framework changed.",effectiveFrom:"2025-11-14",changeStatus:"in_force",sources:[source("Home Affairs — Student visa processing priorities","https://immi.homeaffairs.gov.au/Visa-subsite/Pages/Processing-times/student-visa-processing-priorities.aspx")]},
      {...common,kind:"comparison",title:"Applying with family and subsequent entrants",summary:"Eligible partners and dependent children can still be secondary applicants. A family member applying later is a subsequent entrant and must satisfy the applicable requirements.",previousRule:"Family eligibility and declaration requirements already applied; MD111 used the earlier offshore processing-priority framework.",currentRule:"Secondary applicants are assessed under the Genuine Student dependent criterion. Under MD115, an offshore subsequent-entrant application that includes a minor child is Priority 1; a subsequent entrant without a minor child is Priority 2. These priorities affect processing order only.",newStudentImpact:"Decide carefully whether the family will apply together or join later. Declare eligible family members in the original application, even if they will apply later, and check that the visa permits subsequent entrants.",currentStudentImpact:"Before family applies later, check that the current visa permits subsequent entrants and that the family members were previously declared. Their application must still meet the relevant requirements.",effectiveFrom:"2025-11-14",changeStatus:"in_force",applicability:["Eligible spouse or partner and dependent children.","Offshore subsequent-entrant applications lodged from 14 November 2025."],limitations:["Processing priority is not an approval criterion and does not guarantee a decision time."],sources:[source("Home Affairs — Student visa processing priorities","https://immi.homeaffairs.gov.au/Visa-subsite/Pages/Processing-times/student-visa-processing-priorities.aspx"),source("Home Affairs — Student visa: include family","https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/student-500"),source("Home Affairs — Bringing a partner or family","https://immi.homeaffairs.gov.au/bringing/pages/bringing-a-partner-or-family.aspx"),source("Home Affairs — Genuine Student requirement","https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/student-500/genuine-student-requirement")]},
    ]},
  },
  new_applicant:{
    answer:"For a new applicant, the rules in force when you lodge the application matter. You now prepare Genuine Student answers and evidence, and an offshore application may receive an MD115 processing priority based on the provider and applicant category; that priority is not an approval test.",
    studentView:{title:"Effect on a new applicant",notice:"Application and lodgement dates determine which requirements apply.",cards:[{...common,title:"What a new applicant should do",summary:"Prepare Genuine Student answers and supporting evidence under the current requirement. If applying offshore, check the provider and applicant category used for MD115 processing priority. Processing priority changes assessment order only and does not decide eligibility or guarantee approval.",applicability:["Student visa applicants lodging under the current rules.","MD115 applies to relevant offshore applications lodged on or after 14 November 2025."],sources:[source("Home Affairs — Genuine Student requirement","https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/student-500/genuine-student-requirement"),source("Home Affairs — Student visa processing priorities","https://immi.homeaffairs.gov.au/Visa-subsite/Pages/Processing-times/student-visa-processing-priorities.aspx")]}]},
  },
  current_student:{
    answer:"These changes do not automatically alter an already-granted student visa. Keep following the conditions shown in your visa grant and VEVO; if you lodge another visa application, it will be assessed under the rules applying to that new application.",
    studentView:{title:"Effect on a current student",notice:"An existing visa and a future application must be considered separately.",cards:[{...common,title:"Already studying in Australia",summary:"Continue following the conditions on the current visa grant and check VEVO. The GS and offshore priority changes do not automatically rewrite an already-granted visa. A later application is assessed under the rules in force when it is lodged, and an adviser should check individual circumstances.",sources:[source("Home Affairs — Check visa details and conditions","https://immi.homeaffairs.gov.au/visas/already-have-a-visa/check-visa-details-and-conditions")]}]},
  },
  work:{
    answer:"Most primary Student visa holders can work up to 48 hours per fortnight while their course is in session. Research master's and doctoral students who have started their degree are exempt from that normal cap; check VEVO because scheduled breaks, compulsory course work and family members can be treated differently.",
    studentView:{title:"Working while studying",notice:"Check the conditions on the individual visa in VEVO.",cards:[{...common,title:"Current student work limit",summary:"Most primary Student visa holders may work up to 48 hours per fortnight while the course is in session. A fortnight is 14 days starting on a Monday. Work generally cannot begin before the course starts, subject to the prior-visa exception. Registered compulsory course work is treated differently, and students who have started a master's degree by research or a doctoral degree are exempt from the normal cap.",applicability:["Primary Student visa holders while their course is in session.","Family-member conditions and scheduled course breaks can differ."],sources:[source("Home Affairs — Visa conditions 8104 and 8105","https://immi.homeaffairs.gov.au/visas/already-have-a-visa/check-visa-details-and-conditions/conditions-list")]}]},
  },
} as const;

export function createStudentAgencyTools(client: BusinessManagerClient, research?: BusinessResearchService): RuntimeTool<any, unknown>[] {
  return [{
    definition:{
      name:"showStudentVisaDemoGuidance",
      description:"Immediately display and answer one of the five reviewed student-visa demo topics without web research. Use this for documents, recent changes, effect on a new applicant, effect on a current student, or work while studying. Return the supplied answer once and do not call another student information tool for the same question.",
      parameters:{type:"object",additionalProperties:false,properties:{intent:{type:"string",enum:["documents","recent_changes","new_applicant","current_student","work"]}},required:["intent"]},
    },
    inputSchema:z.object({intent:z.enum(["documents","recent_changes","new_applicant","current_student","work"])}).strict(),
    execute:async input=>({domain:"student_migration",status:"reviewed",...demoGuidance[input.intent as keyof typeof demoGuidance]}),
  },{
    definition: {
      name: "searchStudentAgencyKnowledge",
      description: "Look up reviewed Australian student migration information. When reviewed data has no answer, this automatically searches approved official Australian Government domains. If status is official_evidence, answer from summary and cite its sources. Only if status is unavailable should you say the information could not be confirmed. Separate from property knowledge. Use verifyStudentRules directly for current requirements or rule changes. Use getStudentConsultationSlots to check adviser availability.",
      parameters: { type: "object", additionalProperties: false, properties: {
        q: { type: "string", description: "The student migration question, retaining relevant dates and whether it concerns new or existing students." },
      }, required: ["q"] },
    },
    inputSchema: z.object({ q: z.string().trim().min(2).max(500) }).strict(),
    execute: async input => {
      try {
        const result = await client.searchStudentAgencyKnowledge(input) as { results?: unknown[] };
        if (result.results?.length || !research) return result;
        return await research.researchOfficialStudentInformation(input.q);
      } catch {
        if (research) return await research.researchOfficialStudentInformation(input.q);
        return { domain: "student_migration", status: "unavailable", results: [], liveVerified: false,
          consultationBookingRequiresAvailabilityCheck: true,
          guidance: "Student information could not be verified. Explain this and request agent review; do not answer from memory or real-estate fallback content." };
      }
    },
  }, {
    definition: {
      name: "verifyStudentRules",
      description: "Retrieve official Australian government page content for a student migration topic. Use for current/latest requirements, rule changes and missing reviewed knowledge. Choose the relevant topic; ask which topic for a broad changes question. Returned pages may be partial, cached or unavailable. Cite evidence and dates; do not assume a changed page means a changed rule or that all current students are exempt.",
      parameters: { type: "object", additionalProperties: false, properties: {
        topic: { type: "string", enum: ["general", "duration", "documents", "genuine_student", "english", "finances", "health_cover", "work", "dependants", "processing_priorities", "course_changes", "advisers"] },
      }, required: ["topic"] },
    },
    inputSchema: z.object({ topic: z.enum(["general", "duration", "documents", "genuine_student", "english", "finances", "health_cover", "work", "dependants", "processing_priorities", "course_changes", "advisers"]) }).strict(),
    execute: async input => {
      try {
        const result = await client.verifyStudentRules(input) as { status?: string };
        if (result.status !== "verification_unavailable" || !research) return result;
        return await research.researchOfficialStudentInformation(`Current official Australian student information about ${input.topic.replaceAll("_", " ")}`);
      }
      catch {
        if (research) return await research.researchOfficialStudentInformation(`Current official Australian student information about ${input.topic.replaceAll("_", " ")}`);
        return { domain: "student_migration", status: "verification_unavailable", sources: [], consultationBookingRequiresAvailabilityCheck: true,
        guidance: "Official retrieval failed. Do not claim current verification or answer rules from memory. Offer dated reviewed information if available, otherwise agent review." }; }
    },
  }, {
    definition: {
      name: "compareStudentRules",
      description: "Show source-backed previous/current rules and impacts on new/current students. Clarify the topic and comparison period first. A missing comparison does not mean no change. An optional baselineDate restricts to changes effective on or after that date. Never infer an exemption for existing students.",
      parameters: {type:"object",additionalProperties:false,properties:{
        topic:{type:"string",enum:["general","duration","documents","genuine_student","english","finances","health_cover","work","dependants","processing_priorities","course_changes","advisers"]},
        baselineDate:{type:"string",description:"Optional start of the comparison period, YYYY-MM-DD."}
      },required:["topic"]},
    },
    inputSchema:z.object({topic:z.enum(["general","duration","documents","genuine_student","english","finances","health_cover","work","dependants","processing_priorities","course_changes","advisers"]),baselineDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict(),
    execute:async input=>{
      try{return await client.compareStudentRules(input);}
      catch{return {domain:"student_migration",comparisonStatus:"comparison_unavailable",studentView:{title:"What changed?",cards:[],notice:"The comparison could not be verified. Please try again or ask an agent to review it."},sources:[],consultationBookingRequiresAvailabilityCheck:true};}
    },
  }, {
    definition:{name:"closeStudentView",description:"Close the student information or rule comparison panel when the user asks to close it.",parameters:{type:"object",additionalProperties:false,properties:{}}},
    inputSchema:z.object({}).strict(),execute:async()=>({closeStudentView:true}),
  }];
}
