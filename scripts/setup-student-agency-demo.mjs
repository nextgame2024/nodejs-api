import "dotenv/config";
import fs from "node:fs/promises";
import { validateStudentContent, importStudentContent } from "../src/services/bm.studentContentImport.service.js";
const records=validateStudentContent(JSON.parse(await fs.readFile(new URL("../data/student-agency/faqs.draft.json",import.meta.url),"utf8")));
if(!process.argv.includes("--write")) {
  console.log(JSON.stringify({mode:"validation-only",drafts:records.length}));
} else {
  const companyId=process.argv.find(arg=>arg.startsWith("--company-id="))?.slice("--company-id=".length) || process.env.SOPHIA_RUNTIME_COMPANY_ID || process.env.BM_DEMO_COMPANY_ID;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId||""))throw new Error("Configure SOPHIA_RUNTIME_COMPANY_ID or BM_DEMO_COMPANY_ID");
  const {default:pool}=await import("../src/config/db.js");
  try {
    const {ensureStudentAgencyKnowledgeSchema}=await import("../src/config/startupMigrations.js");
    await ensureStudentAgencyKnowledgeSchema();
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      await importStudentContent(client,companyId,records);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    const {rows}=await pool.query("SELECT publication_status,count(*)::int AS count FROM bm_student_agency_knowledge WHERE company_id=$1 GROUP BY publication_status",[companyId]);
    console.log(JSON.stringify({schema:"ready",knowledge:rows}));
  } finally {await pool.end();}
}
