import { Pool, type PoolClient } from "pg";

type Mode = "preview" | "apply";
type Tenant = { customer_id: string; external_company_id: string };
type StudentUser = {
  id: string;
  company_id: string;
  student_id: string;
  name: string | null;
  email: string | null;
};
type Profile = {
  student_id: string;
  student_reference: string;
  legal_name: string;
  email: string;
};
type Decision =
  | { kind: "linked"; profileId: string }
  | { kind: "link_existing"; profileId: string }
  | { kind: "create" }
  | { kind: "pending"; reason: string };

function options(argv: string[]): { mode: Mode; customerId: string | null } {
  const modes = argv.filter((value) => value === "--preview" || value === "--apply");
  const customerIndex = argv.indexOf("--customer-id");
  const customerId = customerIndex < 0 ? null : argv[customerIndex + 1];
  if (modes.length !== 1 || (customerIndex >= 0 && !customerId)
    || argv.some((value, index) => !["--preview", "--apply", "--customer-id"].includes(value)
      && index !== customerIndex + 1)) {
    throw new Error("Usage: backfill-student-profiles --preview|--apply [--customer-id UUID]");
  }
  if (customerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerId)) {
    throw new Error("--customer-id must be a UUID");
  }
  return { mode: modes[0] === "--apply" ? "apply" : "preview", customerId };
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

async function decide(client: PoolClient, tenantId: string, user: StudentUser): Promise<Decision> {
  if (!user.student_id || !/^STD-[0-9]+$/.test(user.student_id)) {
    return { kind: "pending", reason: "invalid_student_id" };
  }
  if (!user.name?.trim() || !user.email?.trim()) {
    return { kind: "pending", reason: "missing_name_or_email" };
  }
  const existing = await client.query<{ student_id: string; student_reference: string }>(
    `SELECT student_id, student_reference
       FROM sophia_runtime.student_operations_student_user_links
      WHERE customer_id = $1 AND user_id = $2`,
    [tenantId, user.id],
  );
  if (existing.rows.length) {
    return existing.rows[0].student_reference === user.student_id
      ? { kind: "linked", profileId: existing.rows[0].student_id }
      : { kind: "pending", reason: "existing_link_changed_student_id" };
  }

  const profiles = await client.query<Profile>(
    `SELECT p.student_id, p.student_reference, p.legal_name, p.email
       FROM sophia_runtime.student_operations_students p
      WHERE p.customer_id = $1
        AND (p.student_reference = $2
          OR lower(regexp_replace(btrim(p.legal_name), '[[:space:]]+', ' ', 'g')) = $3
          OR lower(btrim(p.email)) = $4)
      ORDER BY p.student_id`,
    [tenantId, user.student_id, normalized(user.name), normalized(user.email)],
  );
  const exact = profiles.rows.filter((profile) => profile.student_reference === user.student_id);
  if (profiles.rows.length === 0) return { kind: "create" };
  if (profiles.rows.length !== 1 || exact.length !== 1) {
    return { kind: "pending", reason: "possible_existing_profile" };
  }
  if (normalized(exact[0].legal_name) !== normalized(user.name)
    || normalized(exact[0].email) !== normalized(user.email)) {
    return { kind: "pending", reason: "profile_identity_mismatch" };
  }
  const linkedElsewhere = await client.query<{ user_id: string }>(
    `SELECT user_id FROM sophia_runtime.student_operations_student_user_links
      WHERE customer_id = $1 AND student_id = $2`,
    [tenantId, exact[0].student_id],
  );
  if (linkedElsewhere.rows.length) {
    return { kind: "pending", reason: "profile_linked_to_another_user" };
  }
  return { kind: "link_existing", profileId: exact[0].student_id };
}

async function inspectOne(
  client: PoolClient, tenant: Tenant, user: StudentUser, mode: Mode,
): Promise<{ kind: string; reason?: string }> {
  await client.query("BEGIN");
  try {
    if (mode === "preview") await client.query("SET TRANSACTION READ ONLY");
    await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenant.customer_id]);
    if (mode === "apply") {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`student-profile-backfill:${tenant.customer_id}`],
      );
    }
    // Recheck the account inside the transaction so an archived/retyped user
    // cannot be linked after the page cursor found it.
    const current = await client.query<StudentUser>(
      `SELECT id, company_id, student_id, name, email FROM public.users
        WHERE id = $1 AND company_id = $2 AND type::text = 'student'
          AND status::text <> 'archived'`,
      [user.id, user.company_id],
    );
    if (!current.rows.length) {
      await client.query("COMMIT");
      return { kind: "skipped" };
    }
    const account = current.rows[0];
    const decision = await decide(client, tenant.customer_id, account);
    if (mode === "preview" || decision.kind === "linked" || decision.kind === "pending") {
      await client.query("COMMIT");
      return decision.kind === "pending"
        ? { kind: "pending", reason: decision.reason }
        : { kind: decision.kind };
    }
    let profileId: string;
    if (decision.kind === "create") {
      const created = await client.query<{ student_id: string }>(
        `INSERT INTO sophia_runtime.student_operations_students
          (customer_id, student_reference, legal_name, email)
         VALUES ($1, $2, $3, $4) RETURNING student_id`,
        [tenant.customer_id, account.student_id, account.name!.trim(), account.email!.trim()],
      );
      profileId = created.rows[0].student_id;
    } else {
      profileId = decision.profileId;
    }
    await client.query(
      `INSERT INTO sophia_runtime.student_operations_student_user_links
        (customer_id, student_id, company_id, user_id, student_reference)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenant.customer_id, profileId, account.company_id, account.id, account.student_id],
    );
    await client.query("COMMIT");
    return { kind: decision.kind === "create" ? "created" : "linked_existing" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runStudentProfileBackfill(pool: Pool, mode: Mode, customerId: string | null = null) {
  const report: {
    mode: Mode;
    counts: Record<string, number>;
    pending: Array<{ customerId: string; userId: string; studentId: string | null; reason: string }>;
    unmappedCompanies: Array<{ companyId: string; studentCount: number }>;
  } = { mode, counts: {}, pending: [], unmappedCompanies: [] };
  const client = await pool.connect();
  try {
    const tenants = await client.query<Tenant>(
      `SELECT customer_id, external_company_id
         FROM sophia_runtime.customers
        WHERE status = 'active' AND external_company_id IS NOT NULL
          AND ($1::uuid IS NULL OR customer_id = $1)
        ORDER BY customer_id`,
      [customerId],
    );
    const unmapped = await client.query<{ company_id: string; student_count: number }>(
      `SELECT u.company_id, count(*)::int AS student_count
         FROM public.users u JOIN public.bm_company c ON c.company_id = u.company_id
        WHERE c.workspace_profile = 'student_operations'
          AND u.type::text = 'student' AND u.status::text <> 'archived'
          AND NOT EXISTS (
            SELECT 1 FROM sophia_runtime.customers t
             WHERE t.external_company_id = u.company_id::text AND t.status = 'active')
        GROUP BY u.company_id ORDER BY u.company_id`,
    );
    report.unmappedCompanies = unmapped.rows.map((row) => ({
      companyId: row.company_id, studentCount: Number(row.student_count),
    }));
    const tenantCount = new Map<string, number>();
    for (const tenant of tenants.rows) {
      tenantCount.set(tenant.external_company_id,
        (tenantCount.get(tenant.external_company_id) ?? 0) + 1);
    }
    for (const tenant of tenants.rows) {
      if (tenantCount.get(tenant.external_company_id)! > 1) {
        report.pending.push({ customerId: tenant.customer_id, userId: "", studentId: null,
          reason: "company_has_multiple_active_tenants" });
        report.counts.pending = (report.counts.pending ?? 0) + 1;
        continue;
      }
      let cursor = "00000000-0000-0000-0000-000000000000";
      while (true) {
        const page = await client.query<StudentUser>(
          `SELECT id, company_id, student_id, name, email FROM public.users
            WHERE company_id::text = $1 AND type::text = 'student'
              AND status::text <> 'archived' AND id > $2::uuid
            ORDER BY id LIMIT 100`,
          [tenant.external_company_id, cursor],
        );
        if (!page.rows.length) break;
        for (const user of page.rows) {
          cursor = user.id;
          try {
            const result = await inspectOne(client, tenant, user, mode);
            report.counts[result.kind] = (report.counts[result.kind] ?? 0) + 1;
            if (result.kind === "pending") report.pending.push({
              customerId: tenant.customer_id, userId: user.id,
              studentId: user.student_id, reason: result.reason!,
            });
          } catch (error) {
            report.counts.pending = (report.counts.pending ?? 0) + 1;
            report.pending.push({ customerId: tenant.customer_id, userId: user.id,
              studentId: user.student_id,
              reason: error instanceof Error && "code" in error
                ? `database_${String(error.code)}` : "write_failed" });
          }
        }
      }
    }
    return report;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("backfill-student-profiles.ts")) {
  try {
    const { mode, customerId } = options(process.argv.slice(2));
    const connectionString = process.env.OWNER_DATABASE_URL;
    if (!connectionString) throw new Error("OWNER_DATABASE_URL is required");
    const pool = new Pool({ connectionString, max: 1 });
    try {
      console.log(JSON.stringify(await runStudentProfileBackfill(pool, mode, customerId), null, 2));
    } finally {
      await pool.end();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backfill failed");
    process.exitCode = 1;
  }
}
