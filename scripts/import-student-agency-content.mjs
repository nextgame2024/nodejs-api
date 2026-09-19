import "dotenv/config";
import fs from "node:fs/promises";
import { validateStudentContent, importStudentContent } from "../src/services/bm.studentContentImport.service.js";

const args = process.argv.slice(2);
const value = key => args.find(arg => arg.startsWith(`${key}=`))?.slice(key.length+1);
const file = value("--file") || "data/student-agency/faqs.draft.json";
const approve = args.includes("--approve");
const reviewer = value("--reviewed-by");
const records = validateStudentContent(JSON.parse(await fs.readFile(file,"utf8")), { approve, reviewer });
if (!args.includes("--write")) {
  console.log(JSON.stringify({mode: "validation-only", records: records.length, publicationStatus: approve ? "approved" : "draft"}));
} else {
  const companyId = value("--company-id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId || "")) throw new Error("An explicit --company-id UUID is required");
  const {default: pool} = await import("../src/config/db.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await importStudentContent(client, companyId, records, {approve,reviewer});
    await client.query("COMMIT");
    console.log(JSON.stringify({imported: records.length, publicationStatus: approve ? "approved" : "draft"}));
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally {client.release();await pool.end();}
}
