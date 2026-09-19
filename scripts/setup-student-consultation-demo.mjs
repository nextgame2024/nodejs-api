import 'dotenv/config';
import pool from '../src/config/db.js';
import {ensureStudentConsultationSchema} from '../src/config/studentConsultationSchema.js';
import {refreshDemoSlots,listSlots} from '../src/models/bm.studentConsultation.model.js';
const companyId=process.argv.find(arg=>arg.startsWith('--company-id='))?.slice('--company-id='.length) || process.env.SOPHIA_RUNTIME_COMPANY_ID || process.env.BM_DEMO_COMPANY_ID;
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId||''))throw new Error('Specify --company-id');
try {
  if(!process.argv.includes('--write')) {console.log('Validation only. Use --write to create the demo calendar.');}
  else {
    await ensureStudentConsultationSchema();
    // Stable ID belongs only to this explicitly labelled synthetic demo adviser.
    await pool.query(`INSERT INTO bm_student_advisers(adviser_id,company_id,adviser_name,service_name,meeting_details,is_demo)
      VALUES ('30000000-0000-4000-8000-000000000041',$1,'Demo student adviser','Student enquiry demonstration',
      'Demonstration appointment only. No real agent meeting, phone call or video link has been arranged.',true)
      ON CONFLICT(adviser_id) DO NOTHING`,[companyId]);
    await refreshDemoSlots(companyId);
    const slots=await listSlots(companyId);
    console.log(JSON.stringify({schema:'ready',availableDemoSlots:slots.filter(s=>s.isDemo).length,nextSlot:slots[0]?.startsAt}));
  }
}finally{await pool.end();}
