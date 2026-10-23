import pool from "../config/db.js";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { allocateStudentId } from "../models/user.model.js";
import {
  groupContacts,
  candidateReason,
  normalizeStudentName,
  usernameBase,
  validEmail,
} from "./bm.studentUserSync.normalization.js";

const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const clean = (value) => String(value ?? "").trim();
// Match Runtime's claim policy: automatic jobs parked outside the overnight
// window are not imports in progress. Processing jobs always block, including
// expired leases awaiting recovery, because their local data may be partial.
const blockingInvoiceRun = () =>
  process.env.STUDENT_USER_SYNC_EXECUTION_MODE === "worker"
    ? `(r.status='processing' OR (r.status='queued' AND
        (r.trigger_type='manual' OR sophia_runtime.student_operations_automatic_window())))`
    : `r.status IN ('queued','processing')`;
const SOURCE = `FROM sophia_runtime.student_operations_xero_invoices i
 LEFT JOIN sophia_runtime.student_operations_xero_contacts c USING(customer_id,xero_connection_id,xero_contact_id)
 WHERE i.customer_id=$1 AND i.xero_connection_id=$2
 AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT')
 AND i.invoice_status NOT IN ('DELETED','VOIDED')`;

// Storage Contacts are explicit links to an existing Sophia identity, not new
// student candidates. In particular, "Documents 2" must never become a user.
async function documentContactMappings(db, scope, connectionId) {
  const installed=await db.query("SELECT to_regclass('sophia_runtime.student_operations_document_contacts') AS name");
  if(!installed.rows[0]?.name) return new Set(); // additive rollout before 091
  const result=await db.query(`SELECT d.xero_contact_id AS contact_id,l.student_reference AS student_id
    FROM sophia_runtime.student_operations_document_contacts d
    JOIN sophia_runtime.student_operations_student_user_links l ON l.customer_id=d.customer_id AND l.student_id=d.student_id
    JOIN public.users u ON u.company_id=$3 AND u.student_id=l.student_reference AND u.type='student' AND u.status='active'
    WHERE d.customer_id=$1 AND d.xero_connection_id=$2 AND d.xero_contact_id IS NOT NULL`,[scope.customer_id,connectionId,scope.company_id]);
  if(!result.rowCount) return new Set();
  const mappings=JSON.stringify(result.rows),params=[scope.customer_id,connectionId,mappings];
  const conflict=await db.query(`SELECT 1 FROM jsonb_to_recordset($3::jsonb) m(contact_id uuid,student_id text)
    JOIN public.bm_xero_student_contact_links l ON l.customer_id=$1 AND l.connection_id=$2 AND l.contact_id=m.contact_id
    WHERE l.student_id<>m.student_id UNION ALL
    SELECT 1 FROM jsonb_to_recordset($3::jsonb) m(contact_id uuid,student_id text)
    JOIN sophia_runtime.student_operations_xero_invoices i ON i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_contact_id=m.contact_id
    WHERE i.student_id IS NOT NULL AND i.student_id<>m.student_id LIMIT 1`,params);
  if(conflict.rowCount) throw fail('Document storage identity conflict; administrator review is required.');
  await db.query(`INSERT INTO public.bm_xero_student_identities(customer_id,company_id,student_id)
    SELECT DISTINCT $1::uuid,$2::uuid,m.student_id FROM jsonb_to_recordset($3::jsonb) m(contact_id uuid,student_id text)
    ON CONFLICT DO NOTHING`,[scope.customer_id,scope.company_id,mappings]);
  await db.query(`INSERT INTO public.bm_xero_student_contact_links(customer_id,connection_id,contact_id,student_id)
    SELECT $1::uuid,$2::uuid,m.contact_id,m.student_id FROM jsonb_to_recordset($3::jsonb) m(contact_id uuid,student_id text)
    ON CONFLICT DO NOTHING`,params);
  await db.query(`UPDATE sophia_runtime.student_operations_xero_invoices i SET student_id=m.student_id
    FROM jsonb_to_recordset($3::jsonb) m(contact_id uuid,student_id text)
    WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_contact_id=m.contact_id AND i.student_id IS NULL`,params);
  return new Set(result.rows.map(row=>row.contact_id));
}

export async function authorizeSync(db, actorId) {
  const { rows } = await db.query(
    `SELECT c.company_id,rc.customer_id FROM users u
    JOIN bm_company c ON c.company_id=u.company_id
    JOIN sophia_runtime.customers rc ON rc.external_company_id=c.company_id::text AND rc.status='active'
    WHERE u.id=$1 AND u.status='active' AND c.status='active' AND c.workspace_profile='student_operations'`,
    [actorId],
  );
  if (rows.length !== 1)
    throw fail(
      "Sync users is only available in your student operations company.",
      403,
    );
  const scope = rows[0];
  await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
    scope.customer_id,
  ]);
  const access = await db.query(
    `SELECT 1 FROM sophia_runtime.business_pack_entitlements
    WHERE customer_id=$1 AND identity_user_id=$2 AND pack_id='student-operations'
    AND status='active' AND role_key='chief_executive'`,
    [scope.customer_id, actorId],
  );
  if (!access.rowCount)
    throw fail(
      "Only a Chief Executive can sync or resolve Student users.",
      403,
    );
  return scope;
}
async function transaction(fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function canAccessStudentSync(actorId, companyId) {
  try {
    return await transaction(
      async (db) => (await authorizeSync(db, actorId)).company_id === companyId,
    );
  } catch (error) {
    if (error.status === 403) return false;
    throw error;
  }
}
async function installed(db) {
  const r = await db.query(
    "SELECT to_regclass('public.bm_xero_student_sync_runs') AS table_name",
  );
  if (!r.rows[0].table_name)
    throw fail(
      "Sync users is not installed yet. Ask your administrator to apply the database migration.",
      503,
    );
}
async function audit(db, scope, actor, action, candidate = null, details = {}) {
  await db.query(
    `INSERT INTO bm_xero_student_sync_audit(customer_id,actor_user_id,candidate_id,action,details)
    VALUES($1,$2,$3,$4,$5)`,
    [scope.customer_id, actor, candidate, action, JSON.stringify(details)],
  );
}
export async function syncOverview(actorId, query = {}) {
  return transaction(async (db) => {
    const scope = await authorizeSync(db, actorId);
    await installed(db);
    const page = Math.max(
      1,
      Math.min(10000, Number.parseInt(query.page, 10) || 1),
    );
    const status = ["ready", "pending", "linked", "excluded"].includes(
      query.status,
    )
      ? query.status
      : "";
    const search = clean(query.q).slice(0, 200);
    const runs = await db.query(
      `SELECT id,mode,status,phase,created_count,processed_count,error,created_at,updated_at
      FROM bm_xero_student_sync_runs WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [scope.customer_id],
    );
    const filter = `customer_id=$1 AND scan_run_id=(SELECT id FROM bm_xero_student_sync_runs
      WHERE customer_id=$1 AND phase IN ('apply','done') ORDER BY created_at DESC LIMIT 1)`;
    const counts = await db.query(
      `SELECT status,count(*)::int count FROM bm_xero_student_sync_candidates WHERE ${filter} GROUP BY status`,
      [scope.customer_id],
    );
    const where = `${filter} AND ($2='' OR status=$2) AND ($3='' OR display_name ILIKE '%'||$3||'%' OR source_names::text ILIKE '%'||$3||'%')`;
    const total = await db.query(
      `SELECT count(*)::int count FROM bm_xero_student_sync_candidates WHERE ${where}`,
      [scope.customer_id, status, search],
    );
    const records = await db.query(
      `SELECT id,display_name,source_names,emails,record_count,status,reason,student_id,resolution_name,resolution_email
      FROM bm_xero_student_sync_candidates WHERE ${where} ORDER BY display_name,id LIMIT 25 OFFSET $4`,
      [scope.customer_id, status, search, (page - 1) * 25],
    );
    return {
      records: records.rows,
      counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.count])),
      runs: runs.rows,
      page,
      total: total.rows[0].count,
      automatic: true,
    };
  });
}
export async function enqueueSync(actorId, mode) {
  if (!["preview", "apply"].includes(mode))
    throw fail("Choose preview or apply.", 400);
  return transaction(async (db) => {
    const scope = await authorizeSync(db, actorId);
    await installed(db);
    await db.query(
      `INSERT INTO bm_xero_student_sync_config(customer_id,company_id,actor_user_id,automatic)
      VALUES($1,$2,$3,true) ON CONFLICT(customer_id) DO UPDATE SET actor_user_id=$3,
      automatic=true`,
      [scope.customer_id, scope.company_id, actorId],
    );
    const result = await db.query(
      `INSERT INTO bm_xero_student_sync_runs(customer_id,actor_user_id,mode)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
      [scope.customer_id, actorId, mode],
    );
    await audit(db, scope, actorId, `sync.${mode}.requested`);
    return { queued: !!result.rowCount };
  });
}
export async function resolveCandidate(actorId, id, input) {
  return transaction(async (db) => {
    const scope = await authorizeSync(db, actorId);
    await installed(db);
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `student-sync:${scope.customer_id}`,
    ]);
    const r = await db.query(
      "SELECT * FROM bm_xero_student_sync_candidates WHERE customer_id=$1 AND id=$2 FOR UPDATE",
      [scope.customer_id, id],
    );
    if (!r.rowCount) throw fail("Record not found.", 404);
    const row = r.rows[0];
    if (row.student_id && row.status === 'linked' && input.action !== "correct")
      throw fail(
        "This record is already linked. Existing student links cannot be replaced here.",
      );
    if (input.action === "exclude") {
      await db.query(
        "UPDATE bm_xero_student_sync_candidates SET status='excluded',reason='Excluded by Chief Executive',resolved_by=$3 WHERE customer_id=$1 AND id=$2",
        [scope.customer_id, id, actorId],
      );
    } else if (input.action === "link") {
      const user = await db.query(
        "SELECT id,student_id FROM users WHERE company_id=$1 AND student_id=$2 AND type='student' AND status='active'",
        [scope.company_id, clean(input.studentId)],
      );
      if (user.rowCount !== 1)
        throw fail("Enter an active Student ID from your company.", 400);
      if (row.student_id && row.student_id !== user.rows[0].student_id)
        throw fail('Existing linked invoices belong to another student. Review the contact grouping.');
      await linkStudent(db, scope, row, user.rows[0].student_id);
      await db.query('SELECT sophia_runtime.reconcile_latest_invoice_advisors($1::uuid)', [scope.customer_id]);
    } else if (input.action === "correct") {
      const name = normalizeStudentName(input.name).name;
      const email = clean(input.email).toLowerCase();
      if (
        !name ||
        name.length > 500 ||
        !/\p{L}/u.test(name) ||
        !validEmail(email)
      )
        throw fail("Enter a student name and valid email.", 400);
      await db.query(
        `UPDATE bm_xero_student_sync_candidates SET resolution_name=$3,resolution_email=$4,
        status='ready',reason=NULL,resolved_by=$5,processed_run_id=NULL WHERE customer_id=$1 AND id=$2`,
        [scope.customer_id, id, name, email, actorId],
      );
    } else throw fail("Choose correct, link or exclude.", 400);
    await audit(db, scope, actorId, `candidate.${input.action}`, id, {
      studentId: input.action === "link" ? clean(input.studentId) : undefined,
    });
    return { saved: true };
  });
}
async function linkStudent(db, scope, row, studentId) {
  await db.query(
    `INSERT INTO bm_xero_student_identities(customer_id,company_id,student_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [scope.customer_id, scope.company_id, studentId],
  );
  const conflict = await db.query(
    `SELECT 1 FROM bm_xero_student_contact_links WHERE customer_id=$1 AND connection_id=$2
    AND contact_id=ANY($3::uuid[]) AND student_id<>$4
    UNION ALL SELECT 1 FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1
    AND xero_connection_id=$2 AND xero_contact_id=ANY($3::uuid[]) AND student_id<>$4`,
    [scope.customer_id, row.connection_id, row.contact_ids, studentId],
  );
  if (conflict.rowCount)
    throw fail("These contacts already belong to another student.");
  await db.query(
    `INSERT INTO bm_xero_student_contact_links(customer_id,connection_id,contact_id,student_id)
    SELECT $1,$2,unnest($3::uuid[]),$4 ON CONFLICT DO NOTHING`,
    [scope.customer_id, row.connection_id, row.contact_ids, studentId],
  );
  await db.query(
    `UPDATE sophia_runtime.student_operations_xero_invoices SET student_id=$4
    WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=ANY($3::uuid[]) AND student_id IS NULL`,
    [scope.customer_id, row.connection_id, row.contact_ids, studentId],
  );
  await db.query(
    `UPDATE bm_xero_student_sync_candidates SET student_id=$3,status='linked',reason=NULL WHERE customer_id=$1 AND id=$2`,
    [scope.customer_id, row.id, studentId],
  );
}

async function scan(db, run, scope) {
  const connection = await db.query(
    `SELECT xero_connection_id,last_successful_sync_at FROM sophia_runtime.student_operations_xero_sync_configurations
    WHERE customer_id=$1 AND enabled AND organisation_role='trust'`,
    [scope.customer_id],
  );
  if (connection.rowCount !== 1 || !connection.rows[0].last_successful_sync_at)
    throw fail("Refresh Xero successfully before syncing users.");
  const source = connection.rows[0];
  const managedContacts=await documentContactMappings(db,scope,source.xero_connection_id);
  const contacts = await db.query(
    `SELECT i.xero_contact_id,c.legal_name,c.email,count(*)::int records ${SOURCE}
    GROUP BY i.xero_contact_id,c.legal_name,c.email`,
    [scope.customer_id, source.xero_connection_id],
  );
  const groups = groupContacts(contacts.rows.filter(contact=>!managedContacts.has(contact.xero_contact_id)));
  const exclusions = await db.query(`SELECT contact_ids FROM bm_xero_student_sync_candidates
    WHERE customer_id=$1 AND connection_id=$2 AND status='excluded'`,
    [scope.customer_id, source.xero_connection_id]);
  const excludedContacts = new Set(exclusions.rows.flatMap(r => r.contact_ids));
  const owners = new Map();
  for (const g of groups)
    for (const email of g.emails) {
      const names = owners.get(email) || new Set();
      names.add(g.key);
      owners.set(email, names);
    }
  const existing = (
    await db.query(
      "SELECT company_id,type,status,name,email,student_id FROM users WHERE lower(email)=ANY($1::text[])",
      [[...owners.keys()]],
    )
  ).rows;
  const payload = groups.map((g) => {
    let reason = candidateReason(g, owners);
    const users = existing.filter((u) =>
      g.emails.includes(u.email.toLowerCase()),
    );
    if (
      !reason &&
      users.length &&
      !(
        users.length === 1 &&
        users[0].company_id === scope.company_id &&
        users[0].type === "student" &&
        users[0].status === "active" &&
        normalizeStudentName(users[0].name).key === g.key
      )
    )
      reason =
        "Email already belongs to an account; review or link an existing Student ID";
    return {
      name_key: g.key,
      display_name: g.name,
      source_names: g.names,
      emails: g.emails,
      contact_ids: g.contacts,
      record_count: g.records,
      status: g.contacts.every(id => excludedContacts.has(id)) ? 'excluded' : reason ? "pending" : "ready",
      reason,
    };
  });
  await db.query(
    `INSERT INTO bm_xero_student_sync_candidates(customer_id,connection_id,name_key,display_name,source_names,emails,contact_ids,record_count,status,reason,scan_run_id)
    SELECT $1,$2,p.name_key,p.display_name,p.source_names,p.emails,p.contact_ids,p.record_count,p.status,p.reason,$3
    FROM jsonb_to_recordset($4::jsonb) AS p(name_key text,display_name text,source_names jsonb,emails jsonb,contact_ids uuid[],record_count int,status text,reason text)
    ON CONFLICT(customer_id,name_key) DO UPDATE SET connection_id=EXCLUDED.connection_id,display_name=EXCLUDED.display_name,
    source_names=EXCLUDED.source_names,emails=EXCLUDED.emails,contact_ids=EXCLUDED.contact_ids,record_count=EXCLUDED.record_count,scan_run_id=$3,
    status=CASE WHEN bm_xero_student_sync_candidates.student_id IS NOT NULL THEN 'linked'
      WHEN bm_xero_student_sync_candidates.status='excluded' AND bm_xero_student_sync_candidates.contact_ids @> EXCLUDED.contact_ids THEN 'excluded'
      WHEN bm_xero_student_sync_candidates.resolved_by IS NOT NULL AND bm_xero_student_sync_candidates.status<>'excluded' THEN 'ready' ELSE EXCLUDED.status END,
    reason=CASE WHEN bm_xero_student_sync_candidates.student_id IS NOT NULL OR bm_xero_student_sync_candidates.resolved_by IS NOT NULL THEN NULL ELSE EXCLUDED.reason END`,
    [
      scope.customer_id,
      source.xero_connection_id,
      run.id,
      JSON.stringify(payload),
    ],
  );
  // A preview must also repair established mappings and expose *all* unlinked
  // transactions, including newly added contacts in a previously linked group.
  const reviewed = await db.query(
    `SELECT c.* FROM bm_xero_student_sync_candidates c WHERE c.customer_id=$1 AND c.scan_run_id=$2 AND c.status<>'excluded'
       AND EXISTS (SELECT 1 FROM sophia_runtime.student_operations_xero_invoices i
         WHERE i.customer_id=c.customer_id AND i.xero_connection_id=c.connection_id
           AND i.xero_contact_id=ANY(c.contact_ids) AND i.student_id IS NULL
           AND i.invoice_status NOT IN ('DELETED','VOIDED'))`,
    [scope.customer_id, run.id],
  );
  for (const row of reviewed.rows) {
    await db.query('SAVEPOINT preview_link');
    try {
      // Pending candidates cannot create accounts, but existing stable mappings
      // can safely populate new invoices during every post-Xero scan.
      await applyCandidate(db, run, scope, { ...row, status: 'pending', reason: null });
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT preview_link');
      if (!error.status && error.code !== '23505') throw error;
      await db.query("UPDATE bm_xero_student_sync_candidates SET status='pending',reason=$3 WHERE customer_id=$1 AND id=$2",
        [scope.customer_id,row.id,error.status ? error.message : 'Account details conflict; review the Student ID.']);
    }
    await db.query('RELEASE SAVEPOINT preview_link');
  }
  await db.query(
    `UPDATE bm_xero_student_sync_candidates c SET status='pending',
      reason=COALESCE(reason,'Invoice has no Student ID; review or sync ready users')
     WHERE c.customer_id=$1 AND c.scan_run_id=$2 AND c.status<>'excluded'
       AND EXISTS (SELECT 1 FROM sophia_runtime.student_operations_xero_invoices i
         WHERE i.customer_id=c.customer_id AND i.xero_connection_id=c.connection_id
           AND i.xero_contact_id=ANY(c.contact_ids) AND i.student_id IS NULL
           AND i.invoice_status NOT IN ('DELETED','VOIDED'))`,
    [scope.customer_id, run.id],
  );
  // Keep PostgreSQL timestamp precision; round-tripping through JS Date can cause endless refresh jobs.
  await db.query('SELECT sophia_runtime.reconcile_latest_invoice_advisors($1::uuid)', [scope.customer_id]);
  if (process.env.STUDENT_SYNC_PIPELINE_ENABLED === 'true' && run.mode === 'apply') {
    // A previous preview checkpoint is not completion of the apply stage.
    // Hold further document claims until every apply batch has committed.
    await db.query(`DELETE FROM sophia_runtime.student_operations_sync_checkpoints
      WHERE customer_id=$1 AND xero_connection_id=$2`,[scope.customer_id,source.xero_connection_id]);
  }
  await db.query(`UPDATE bm_xero_student_sync_config SET last_source_sync=(
    SELECT last_successful_sync_at FROM sophia_runtime.student_operations_xero_sync_configurations
     WHERE customer_id=$1 AND xero_connection_id=$2) WHERE customer_id=$1`,
    [scope.customer_id, source.xero_connection_id]);
  await db.query(
    `UPDATE bm_xero_student_sync_runs SET source_sync=(SELECT last_successful_sync_at
    FROM sophia_runtime.student_operations_xero_sync_configurations WHERE customer_id=$2 AND xero_connection_id=$3),
    ${process.env.STUDENT_SYNC_PIPELINE_ENABLED === 'true' ? 'source_connection_id=$3,' : ''}
    phase=$4,status=$5,processed_count=$6,updated_at=now() WHERE id=$1`,
    [
      run.id,
      scope.customer_id,
      source.xero_connection_id,
      run.mode === "preview" ? "done" : "apply",
      run.mode === "preview" ? "succeeded" : "processing",
      run.mode === "preview" ? groups.length : 0,
    ],
  );
}
async function applyCandidate(db, run, scope, row) {
  const mapped = await db.query(
    `SELECT contact_id, student_id FROM bm_xero_student_contact_links
    WHERE customer_id=$1 AND connection_id=$2 AND contact_id=ANY($3::uuid[])`,
    [scope.customer_id, row.connection_id, row.contact_ids],
  );
  const ids = new Set(mapped.rows.map((r) => r.student_id));
  if (row.student_id) ids.add(row.student_id);
  if (ids.size > 1)
    throw fail("Contacts are linked to different students; review required.");
  if (ids.size === 1) {
    const knownContacts = new Set(mapped.rows.map((link) => link.contact_id));
    if (
      row.contact_ids.some((id) => !knownContacts.has(id)) &&
      !row.resolution_email
    ) {
      const linkedUser = await db.query(
        "SELECT email FROM users WHERE company_id=$1 AND student_id=$2",
        [scope.company_id, [...ids][0]],
      );
      if (
        row.emails.some(
          (email) =>
            email.toLowerCase() !== linkedUser.rows[0]?.email.toLowerCase(),
        )
      ) {
        throw fail(
          "New contacts have a different email from the linked student. Confirm the name and email before linking them.",
        );
      }
    }
    await linkStudent(db, scope, row, [...ids][0]);
    return false;
  }
  if (row.status !== "ready" && row.reason !== 'Invoice has no Student ID; review or sync ready users') return false;
  const name = row.resolution_name || row.display_name;
  const key = normalizeStudentName(name).key;
  const email = row.resolution_email || row.emails[0];
  if (!validEmail(email)) throw fail("Email is missing or invalid.");
  const siblings = await db.query(
    `SELECT id,display_name,resolution_name FROM bm_xero_student_sync_candidates
    WHERE customer_id=$1 AND id<>$2 AND status<>'excluded' AND scan_run_id=$3
    AND (resolution_email=$4 OR (resolution_email IS NULL AND emails ? $4))`,
    [scope.customer_id, row.id, run.id, email],
  );
  if (
    siblings.rows.some(
      (r) =>
        normalizeStudentName(r.resolution_name || r.display_name).key !== key,
    )
  )
    throw fail(
      "Email is shared by different names; correct the email or link an existing Student ID.",
    );
  const users = await db.query(
    `SELECT id,company_id,name,email,type,status,student_id FROM users
    WHERE company_id=$1 OR lower(email)=$2`,
    [scope.company_id, email],
  );
  const matches = users.rows.filter(
    (u) =>
      u.company_id === scope.company_id &&
      u.type === "student" &&
      normalizeStudentName(u.name).key === key,
  );
  const emailMatches = users.rows.filter(
    (u) => u.email.toLowerCase() === email,
  );
  if (matches.length > 1)
    throw fail(
      "Multiple Student users have this name; link the correct Student ID.",
    );
  if (matches.length === 1) {
    const user = matches[0];
    if (
      user.status !== "active" ||
      user.email.toLowerCase() !== email ||
      emailMatches.length !== 1
    )
      throw fail(
        "Existing Student details differ; review and link the correct Student ID.",
      );
    let studentId = user.student_id;
    if (!studentId) {
      studentId = await allocateStudentId(db);
      await db.query("UPDATE users SET student_id=$2 WHERE id=$1", [
        user.id,
        studentId,
      ]);
    }
    await linkStudent(db, scope, row, studentId);
    return false;
  }
  if (emailMatches.length)
    throw fail(
      "Email already belongs to an account; correct it or link an existing Student ID.",
    );
  // Serialize allocation across imports. Database uniqueness remains the final race guard.
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext('student-sync:account-allocation'))",
  );
  const base = usernameBase(name);
  let username = base;
  let suffix = 2;
  while (
    (await db.query("SELECT 1 FROM users WHERE lower(username)=$1", [username]))
      .rowCount
  )
    username = `${base}${suffix++}`;
  const studentId = await allocateStudentId(db);
  // No shared credential. Password setup requires a verified single-use link;
  // do not log, return or send this unknown secret. Migration 088 marks the row.
  const hash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10);
  await db.query(
    `INSERT INTO users(id,company_id,name,email,username,password,type,status,student_id,student_name_in_xero,image,bio)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'student','active',$6,$7,'','')`,
    [
      scope.company_id,
      name,
      email,
      username,
      hash,
      studentId,
      row.source_names[0],
    ],
  );
  await linkStudent(db, scope, row, studentId);
  await audit(db, scope, run.actor_user_id, "student.created", row.id, {
    studentId,
    normalizationVersion: 1,
    temporaryPassword: true,
  });
  return true;
}

export async function scheduleStudentSync(db) {
  const worker=process.env.STUDENT_USER_SYNC_EXECUTION_MODE === 'worker';
  const automaticWindow=worker ? 'sophia_runtime.student_operations_automatic_window()' : 'true';
  // Bootstrap only eligible companies with an active Chief Executive. Each
  // batch reauthorizes the actor; scheduling never grants staff permissions.
  await db.query(`INSERT INTO bm_xero_student_sync_config(customer_id,company_id,actor_user_id,automatic)
    SELECT DISTINCT ON (c.customer_id) c.customer_id,b.company_id,u.id,true
    FROM sophia_runtime.customers c JOIN bm_company b ON b.company_id::text=c.external_company_id
    JOIN users u ON u.company_id=b.company_id AND u.status='active'
    JOIN sophia_runtime.business_pack_entitlements e ON e.customer_id=c.customer_id
      AND e.identity_user_id=u.id::text AND e.pack_id='student-operations'
      AND e.status='active' AND e.role_key='chief_executive'
    WHERE c.status='active' AND b.status='active' AND b.workspace_profile='student_operations'
    ORDER BY c.customer_id,u.id ON CONFLICT DO NOTHING`);
  // Atomic enqueue/checkpoint, plus the existing unique active-run index,
  // prevents duplicate jobs across API replicas. Nightly runs take priority.
  await db.query(`WITH due AS (
    SELECT c.customer_id,c.actor_user_id,
      (c.next_nightly_at<=now() AND ${automaticWindow}) AS nightly
    FROM bm_xero_student_sync_config c
    JOIN sophia_runtime.student_operations_xero_sync_configurations x USING(customer_id)
    WHERE c.automatic AND x.enabled AND x.organisation_role='trust'
      AND x.last_successful_sync_at IS NOT NULL
      AND ((c.next_nightly_at<=now() AND ${automaticWindow})
        OR c.last_source_sync IS DISTINCT FROM x.last_successful_sync_at)
      AND NOT EXISTS (SELECT 1 FROM sophia_runtime.student_operations_xero_sync_runs r
        WHERE r.customer_id=c.customer_id AND ${blockingInvoiceRun()})
      AND NOT EXISTS (SELECT 1 FROM bm_xero_student_sync_runs r
        WHERE r.customer_id=c.customer_id AND r.status IN ('queued','processing'))
      AND NOT EXISTS (SELECT 1 FROM bm_xero_student_sync_runs r
        WHERE r.customer_id=c.customer_id AND r.status='failed' AND r.updated_at>now()-interval '5 minutes')
    FOR UPDATE OF c SKIP LOCKED
  ), queued AS (
    INSERT INTO bm_xero_student_sync_runs(customer_id,actor_user_id,mode${process.env.STUDENT_USER_SYNC_EXECUTION_MODE === 'worker' ? ',trigger_type' : ''})
    SELECT customer_id,actor_user_id,CASE WHEN nightly THEN 'apply' ELSE 'preview' END
      ${process.env.STUDENT_USER_SYNC_EXECUTION_MODE === 'worker' ? ",CASE WHEN nightly THEN 'nightly' ELSE 'source' END" : ''} FROM due
    ON CONFLICT DO NOTHING RETURNING customer_id,mode
  ) UPDATE bm_xero_student_sync_config c SET next_nightly_at=
    (((now() AT TIME ZONE 'Australia/Brisbane')::date + 1 + time '02:00') AT TIME ZONE 'Australia/Brisbane')
    FROM queued q WHERE c.customer_id=q.customer_id AND q.mode='apply'`);
}

// Transaction-scoped locks also work with transaction-pooling database URLs.
// Each bounded batch commits accounts, mappings and checkpoints together.
export async function processSyncBatch({ schedule = true, throwOnError = false } = {}) {
  const db = await pool.connect();
  try {
    const available = await db.query(
      "SELECT to_regclass('public.bm_xero_student_sync_runs') AS name",
    );
    if (!available.rows[0].name) return;
    if (schedule) await scheduleStudentSync(db);
    const runs = await db.query(
      `SELECT * FROM bm_xero_student_sync_runs WHERE status IN ('queued','processing')
       ${process.env.STUDENT_USER_SYNC_EXECUTION_MODE === 'worker' ? `AND (trigger_type<>'nightly' OR
         sophia_runtime.student_operations_automatic_window())` : ''}
       ORDER BY created_at LIMIT 10`,
    );
    for (const queuedRun of runs.rows) {
      try {
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        if (
          !(
            await db.query(
              "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
              [`student-sync:${queuedRun.customer_id}`],
            )
          ).rows[0].acquired
        ) {
          await db.query("ROLLBACK");
          continue;
        }
        const current = await db.query(
          "SELECT * FROM bm_xero_student_sync_runs WHERE id=$1 AND status IN ('queued','processing') FOR UPDATE",
          [queuedRun.id],
        );
        if (!current.rowCount) {
          await db.query("ROLLBACK");
          continue;
        }
        const run = current.rows[0];
        const scope = await authorizeSync(db, run.actor_user_id);
        if (scope.customer_id !== run.customer_id)
          throw fail(
            "The requesting user no longer belongs to this company.",
            403,
          );
        const refreshing = await db.query(
          `SELECT 1 FROM sophia_runtime.student_operations_xero_sync_runs r
           WHERE r.customer_id=$1 AND ${blockingInvoiceRun()} LIMIT 1`,
          [scope.customer_id],
        );
        if (refreshing.rowCount) {
          // Dependency wait, not a failed identity operation. Keep the same job
          // and checkpoint untouched; reauthorize and retry on the next poll.
          await db.query("ROLLBACK");
          continue;
        }
        if (run.phase === "scan") {
          await scan(db, run, scope);
          if (run.mode === 'preview') await checkpointStudentSync(db,run);
          await db.query("COMMIT");
          continue;
        }
        const candidates = await db.query(
          `SELECT * FROM bm_xero_student_sync_candidates WHERE customer_id=$1 AND scan_run_id=$2
          AND processed_run_id IS DISTINCT FROM $2 ORDER BY name_key,id LIMIT 20`,
          [run.customer_id, run.id],
        );
        for (const row of candidates.rows) {
          await db.query("SAVEPOINT candidate");
          let created = false;
          try {
            if (row.status !== "excluded")
              created = await applyCandidate(db, run, scope, row);
          } catch (error) {
            await db.query("ROLLBACK TO SAVEPOINT candidate");
            if (!error.status && error.code !== "23505") throw error;
            await db.query(
              "UPDATE bm_xero_student_sync_candidates SET status='pending',reason=$3 WHERE customer_id=$1 AND id=$2",
              [
                scope.customer_id,
                row.id,
                error.status
                  ? error.message
                  : "Account details were used by another account. Review and retry.",
              ],
            );
          }
          await db.query(
            "UPDATE bm_xero_student_sync_candidates SET processed_run_id=$3 WHERE customer_id=$1 AND id=$2",
            [scope.customer_id, row.id, run.id],
          );
          await db.query(
            "UPDATE bm_xero_student_sync_runs SET processed_count=processed_count+1,created_count=created_count+$2,updated_at=now() WHERE id=$1",
            [run.id, created ? 1 : 0],
          );
          await db.query("RELEASE SAVEPOINT candidate");
        }
        await db.query('SELECT sophia_runtime.reconcile_latest_invoice_advisors($1::uuid)', [scope.customer_id]);
        if (!candidates.rowCount) {
          await db.query(
            "UPDATE bm_xero_student_sync_runs SET status='succeeded',phase='done',updated_at=now() WHERE id=$1",
            [run.id],
          );
          await db.query(
            "UPDATE bm_xero_student_sync_config SET last_source_sync=(SELECT source_sync FROM bm_xero_student_sync_runs WHERE id=$2) WHERE customer_id=$1",
            [scope.customer_id, run.id],
          );
          await checkpointStudentSync(db,run);
        }
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        // Another worker/manual user update can legitimately cause a serialization retry.
        if (error.code === "40001" || error.code === "40P01") continue;
        await db.query(
          "UPDATE bm_xero_student_sync_runs SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status IN ('queued','processing')",
          [
            queuedRun.id,
            error.status
              ? error.message
              : "Sync could not finish. Completed accounts are saved; retry the run.",
          ],
        );
        console.error(
          "Student user sync failed",
          error.code || error.status || "internal",
        );
      }
    }
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Student sync worker unavailable", error.code || "internal");
    if (throwOnError) throw error;
  } finally {
    db.release();
  }
}

async function checkpointStudentSync(db,run) {
  if (process.env.STUDENT_SYNC_PIPELINE_ENABLED !== 'true') return;
  // Publish only after the scan/apply succeeded; use PostgreSQL timestamps
  // directly to retain precision. This commits with the identity/link changes.
  await db.query(`INSERT INTO sophia_runtime.student_operations_sync_checkpoints
    (customer_id,xero_connection_id,source_sync_at,reconciled_at)
    SELECT r.customer_id,x.xero_connection_id,r.source_sync,now()
    FROM bm_xero_student_sync_runs r
    JOIN sophia_runtime.student_operations_xero_sync_configurations x
      ON x.customer_id=r.customer_id AND x.xero_connection_id=r.source_connection_id
    WHERE r.id=$1 AND r.customer_id=$2 AND r.source_sync IS NOT NULL
      AND x.enabled AND x.organisation_role='trust'
    ON CONFLICT(customer_id,xero_connection_id) DO UPDATE SET
      source_sync_at=greatest(student_operations_sync_checkpoints.source_sync_at,EXCLUDED.source_sync_at),
      reconciled_at=now()`,[run.id,run.customer_id]);
}
export function startStudentUserSyncWorker() {
  let busy = false;
  let lastScheduled = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const schedule = Date.now() - lastScheduled >= 60_000;
      await processSyncBatch({ schedule });
      if (schedule) lastScheduled = Date.now();
    } catch (error) {
      console.error(
        "Student sync connection unavailable",
        error.code || "internal",
      );
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  void tick();
  return timer;
}
