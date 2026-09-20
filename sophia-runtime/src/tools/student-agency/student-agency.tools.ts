import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";
import type { BusinessManagerClient } from "../real-estate/business-manager.client.js";

export function createStudentAgencyTools(client: BusinessManagerClient): RuntimeTool<any, unknown>[] {
  return [{
    definition: {
      name: "searchStudentAgencyKnowledge",
      description: "Look up reviewed Australian student migration information, including previous/current rules and impacts on new/existing students where documented. Separate from property knowledge. Use verifyStudentRules for current requirements or rule changes and when no reviewed answer is available. Use getStudentConsultationSlots to check adviser availability.",
      parameters: { type: "object", additionalProperties: false, properties: {
        q: { type: "string", description: "The student migration question, retaining relevant dates and whether it concerns new or existing students." },
      }, required: ["q"] },
    },
    inputSchema: z.object({ q: z.string().trim().min(2).max(500) }).strict(),
    execute: async input => {
      try {
        return await client.searchStudentAgencyKnowledge(input);
      } catch {
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
        topic: { type: "string", enum: ["general", "duration", "documents", "genuine_student", "english", "finances", "health_cover", "work", "dependants", "course_changes", "advisers"] },
      }, required: ["topic"] },
    },
    inputSchema: z.object({ topic: z.enum(["general", "duration", "documents", "genuine_student", "english", "finances", "health_cover", "work", "dependants", "course_changes", "advisers"]) }).strict(),
    execute: async input => {
      try { return await client.verifyStudentRules(input); }
      catch { return { domain: "student_migration", status: "verification_unavailable", sources: [], consultationBookingRequiresAvailabilityCheck: true,
        guidance: "Official retrieval failed. Do not claim current verification or answer rules from memory. Offer dated reviewed information if available, otherwise agent review." }; }
    },
  }, {
    definition: {
      name: "compareStudentRules",
      description: "Show source-backed previous/current rules and impacts on new/current students. Clarify the topic and comparison period first. A missing comparison does not mean no change. An optional baselineDate restricts to changes effective on or after that date. Never infer an exemption for existing students.",
      parameters: {type:"object",additionalProperties:false,properties:{
        topic:{type:"string",enum:["general","duration","documents","genuine_student","english","finances","health_cover","work","dependants","course_changes","advisers"]},
        baselineDate:{type:"string",description:"Optional start of the comparison period, YYYY-MM-DD."}
      },required:["topic"]},
    },
    inputSchema:z.object({topic:z.enum(["general","duration","documents","genuine_student","english","finances","health_cover","work","dependants","course_changes","advisers"]),baselineDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict(),
    execute:async input=>{
      try{return await client.compareStudentRules(input);}
      catch{return {domain:"student_migration",comparisonStatus:"comparison_unavailable",studentView:{title:"What changed?",cards:[],notice:"The comparison could not be verified. Please try again or ask an agent to review it."},sources:[],consultationBookingRequiresAvailabilityCheck:true};}
    },
  }, {
    definition:{name:"closeStudentView",description:"Close the student information or rule comparison panel when the user asks to close it.",parameters:{type:"object",additionalProperties:false,properties:{}}},
    inputSchema:z.object({}).strict(),execute:async()=>({closeStudentView:true}),
  }];
}
