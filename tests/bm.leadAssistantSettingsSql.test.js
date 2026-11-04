import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { defaults } from "../src/services/leads/assistant-settings.contracts.js";
const url = process.env.LOCAL_LEAD_SETTINGS_TEST_DATABASE_URL;
if (url && !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw new Error("Use a disposable local PostgreSQL database.");
const suite = url ? describe : describe.skip;
const pool = new Pool({
  connectionString: url ?? "postgresql://postgres@127.0.0.1:1/not_used",
  max: 3,
});
jest.unstable_mockModule("../src/config/db.js", () => ({ default: pool }));
const api = await import("../src/services/leads/assistant-settings.service.js");
const t = "11111111-1111-4111-8111-111111111111",
  company = "22222222-2222-4222-8222-222222222222",
  owner = "33333333-3333-4333-8333-333333333333",
  advisor = "44444444-4444-4444-8444-444444444444",
  foreign = "55555555-5555-4555-8555-555555555555",
  otherCompany = "66666666-6666-4666-8666-666666666666",
  other = "77777777-7777-4777-8777-777777777777",
  platformAdmin = "88888888-8888-4888-8888-888888888888";
const complete = () => ({
  ...defaults(),
  businessName: "Example business",
  contactName: "Enquiries team",
  supportContact: "support@example.test",
  enquiryOwnerId: owner,
  contentOwnerId: owner,
  fallbackOwnerId: owner,
  advisorIds: [advisor],
  greeting: "Hello",
  afterHoursMessage: "Our team will reply during coverage hours.",
  coverage: [{ day: 1, start: "09:00", end: "17:00" }],
});
suite("Assistant Settings using isolated PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
   CREATE SCHEMA sophia_runtime; GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
   CREATE TABLE public.bm_company(company_id uuid PRIMARY KEY,status text);
   CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,name text,status text,type text);
   CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
   CREATE TABLE sophia_runtime.admin_memberships(customer_id uuid,identity_user_id text,status text,role_key text);
   CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,status text,pack_id text,role_key text);
   CREATE TABLE sophia_runtime.platform_operator_assignments(identity_user_id text,operator_company_id uuid,status text);
   GRANT SELECT ON sophia_runtime.admin_memberships,sophia_runtime.business_pack_entitlements,sophia_runtime.platform_operator_assignments TO sophia_runtime_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA sophia_runtime GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO sophia_runtime_app;`);
    await pool.query(
      "INSERT INTO public.bm_company VALUES($1,'active'),($2,'active')",
      [company, otherCompany],
    );
    await pool.query(
      "INSERT INTO public.users VALUES($1,$3,'Owner','active','employee'),($2,$3,'Advisor','active','advisor'),($4,$5,'Other company member','active','employee'),($6,$3,'Platform Admin','active','admin')",
      [owner, advisor, company, foreign, otherCompany, platformAdmin],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.customers VALUES($1,$2,'active'),($3,$4,'active')",
      [t, company, other, otherCompany],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.admin_memberships VALUES($1,$2,'active','organisation_owner')",
      [t, owner],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.platform_operator_assignments VALUES($1,$2,'active')",
      [platformAdmin, company],
    );
    const sql = (
      await readFile(
        new URL(
          "../sophia-runtime/src/database/migrations/116_lead_assistant_settings.sql",
          import.meta.url,
        ),
        "utf8",
      )
    ).replaceAll("__SOPHIA_RUNTIME_SCHEMA__", "sophia_runtime");
    await pool.query(sql);
  });
  afterAll(async () => pool.end());
  test("resolves tenant from current account and refuses advisor or company spoofing", async () => {
    await expect(api.getSettings(advisor, company)).rejects.toMatchObject({
      status: 403,
    });
    await expect(api.getSettings(owner, otherCompany)).rejects.toMatchObject({
      status: 403,
    });
    const result = await api.getSettings(owner, company);
    expect(result.revision).toBe(0);
    expect(result.published).toBeNull();
    expect(result.staff.map((u) => u.id)).toEqual(
      expect.arrayContaining([owner, advisor]),
    );
    expect(result.staff.some((u) => u.id === foreign)).toBe(false);
    expect(Object.keys(result.staff[0]).sort()).toEqual(["id", "name"]);
  });
  test("refuses cross-company staff and rejects a changed membership on the next request", async () => {
    await expect(
      api.saveSettings(owner, company, {
        expectedRevision: 0,
        configuration: { ...complete(), advisorIds: [foreign] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await pool.query(
      "UPDATE sophia_runtime.admin_memberships SET status='inactive' WHERE identity_user_id=$1",
      [owner],
    );
    await expect(api.getSettings(owner, company)).rejects.toMatchObject({
      status: 403,
    });
    await pool.query(
      "UPDATE sophia_runtime.admin_memberships SET status='active' WHERE identity_user_id=$1",
      [owner],
    );
  });
  test("allows an active platform operator to manage only its internal company tenant", async () => {
    const result = await api.getSettings(platformAdmin, company);
    expect(result.canManage).toBe(true);
    expect(result.staff.map((user) => user.id)).toEqual(
      expect.arrayContaining([owner, advisor, platformAdmin]),
    );

    await expect(api.getSettings(platformAdmin, otherCompany)).rejects.toMatchObject({
      status: 403,
    });
    await pool.query(
      "UPDATE sophia_runtime.platform_operator_assignments SET status='revoked' WHERE identity_user_id=$1",
      [platformAdmin],
    );
    await expect(api.getSettings(platformAdmin, company)).rejects.toMatchObject({
      status: 403,
    });
    await pool.query(
      "UPDATE sophia_runtime.platform_operator_assignments SET status='active' WHERE identity_user_id=$1",
      [platformAdmin],
    );
  });
  test("concurrent first saves and stale edits cannot overwrite a newer draft", async () => {
    const writes = await Promise.allSettled([
      api.saveSettings(owner, company, {
        expectedRevision: 0,
        configuration: defaults(),
      }),
      api.saveSettings(owner, company, {
        expectedRevision: 0,
        configuration: complete(),
      }),
    ]);
    expect(writes.filter((w) => w.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((w) => w.status === "rejected")[0].reason.status).toBe(
      409,
    );
    await expect(
      api.saveSettings(owner, company, {
        expectedRevision: 0,
        configuration: complete(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await api.saveSettings(owner, company, {
      expectedRevision: 1,
      configuration: defaults(),
    });
    await expect(
      api.publishSettings(owner, company, { expectedRevision: 2 }),
    ).rejects.toMatchObject({
      status: 400,
      fields: expect.arrayContaining(["coverage", "advisorIds"]),
    });
  });
  test("publishes an immutable snapshot and retries publication without duplicate audit", async () => {
    await api.saveSettings(owner, company, {
      expectedRevision: 2,
      configuration: complete(),
    });
    const result = await api.publishSettings(owner, company, {
      expectedRevision: 3,
    });
    const repeated = await api.publishSettings(owner, company, {
      expectedRevision: 3,
    });
    expect(repeated.published.release_id).toBe(result.published.release_id);
    const edited = await api.saveSettings(owner, company, {
      expectedRevision: 3,
      configuration: { ...complete(), greeting: "New draft greeting" },
    });
    expect(edited.configuration.greeting).toBe("New draft greeting");
    expect(edited.published.configuration.greeting).toBe("Hello");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM sophia_runtime.lead_assistant_settings_audit WHERE action='published'",
        )
      ).rows[0].count,
    ).toBe(1);
  });
  test("requires current active staff at publication, even after a valid draft was saved", async () => {
    await pool.query("UPDATE public.users SET status='archived' WHERE id=$1", [
      advisor,
    ]);
    await expect(
      api.publishSettings(owner, company, { expectedRevision: 4 }),
    ).rejects.toMatchObject({ status: 400 });
    await pool.query("UPDATE public.users SET status='active' WHERE id=$1", [
      advisor,
    ]);
  });
  test("supports the existing Chief Executive authority without requiring Admin membership", async () => {
    await pool.query(
      "UPDATE sophia_runtime.admin_memberships SET status='suspended' WHERE identity_user_id=$1",
      [owner],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.business_pack_entitlements VALUES($1,$2,'active','student-operations','chief_executive')",
      [t, owner],
    );
    expect((await api.getSettings(owner, company)).canManage).toBe(true);
    await pool.query(
      "UPDATE sophia_runtime.business_pack_entitlements SET status='revoked' WHERE identity_user_id=$1",
      [owner],
    );
    await expect(api.getSettings(owner, company)).rejects.toMatchObject({
      status: 403,
    });
    await pool.query(
      "UPDATE sophia_runtime.admin_memberships SET status='active' WHERE identity_user_id=$1",
      [owner],
    );
  });
  test("app-role RLS isolates another tenant and prevents release modification", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [other]);
      expect(
        (await db.query("SELECT * FROM sophia_runtime.lead_assistant_settings"))
          .rows,
      ).toHaveLength(0);
      await expect(
        db.query(
          "INSERT INTO sophia_runtime.lead_assistant_settings(customer_id,draft,updated_by_identity) VALUES($1,'{}','spoof')",
          [t],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await db.query("ROLLBACK");
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [t]);
      await expect(
        db.query(
          "UPDATE sophia_runtime.lead_assistant_setting_releases SET configuration='{}'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
  });
});
