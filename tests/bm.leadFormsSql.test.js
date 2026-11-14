import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  beforeAll,
  afterAll,
  describe,
  test,
  expect,
  jest,
} from "@jest/globals";
// Opt-in: creates and removes its own isolated database on a local server.
const url = process.env.LOCAL_LEAD_FORMS_ADMIN_URL;
if (url && !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw new Error("Local PostgreSQL only.");
const suite = url ? describe : describe.skip;
const dbName = "codex_lead_forms_" + randomUUID().replaceAll("-", "");
const admin = new Pool({
  connectionString: url ?? "postgresql://localhost:1/postgres",
});
const testUrl = new URL(url ?? "postgresql://localhost:1/postgres");
testUrl.pathname = "/" + dbName;
const pool = new Pool({ connectionString: testUrl.toString() });
const tenant = randomUUID(),
  otherTenant = randomUUID();
jest.unstable_mockModule(
  "../src/services/leads/assistant-settings.service.js",
  () => ({
    transaction: async (actor, company, work) => {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SET LOCAL ROLE sophia_runtime_app");
        await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
          company,
        ]);
        const out = await work(db, company, {
          canManageLeads: actor === "owner",
        });
        await db.query("COMMIT");
        return out;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      } finally {
        db.release();
      }
    },
  }),
);
const api = await import("../src/services/leads/lead-forms.service.js");
let created = false;
suite("Lead forms PostgreSQL migration, CRUD and tenant isolation", () => {
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    created = true;
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
    CREATE SCHEMA sophia_runtime; GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
    CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY);`);
    await pool.query("INSERT INTO sophia_runtime.customers VALUES($1),($2)", [
      tenant,
      otherTenant,
    ]);
    await pool.query(
      (
        await readFile(
          new URL(
            "../sophia-runtime/src/database/migrations/131_lead_forms.sql",
            import.meta.url,
          ),
          "utf8",
        )
      ).replaceAll("__SOPHIA_RUNTIME_SCHEMA__", "sophia_runtime"),
    );
  });
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${dbName}"`);
    await admin.end();
  });
  test("defaults, type uniqueness, saves, paging, optimistic updates and deletion", async () => {
    const types = (await api.listTypes("owner", tenant)).items;
    expect(types.map((t) => t.name)).toEqual(["Marketing", "Technical"]);
    const type = await api.createType("owner", tenant, { name: "Discovery" });
    await expect(
      api.createType("owner", tenant, { name: "discovery" }),
    ).rejects.toMatchObject({ status: 409 });
    const id = randomUUID(),
      form = {
        name: "AI discovery",
        typeId: type.id,
        blocks: [
          {
            id: randomUUID(),
            kind: "title",
            text: "Discover AI",
            required: false,
            options: [],
          },
        ],
      };
    await api.saveForm("owner", tenant, id, { expectedVersion: 0, form });
    expect((await api.listForms("owner", tenant, { sort: "type" })).total).toBe(
      1,
    );
    expect((await api.getForm("owner", tenant, id)).blocks).toEqual(
      form.blocks,
    );
    await expect(
      api.deleteType("owner", tenant, type.id),
    ).rejects.toMatchObject({ status: 409 });
    await expect(api.getForm("owner", otherTenant, id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      api.saveForm("owner", otherTenant, randomUUID(), {
        expectedVersion: 0,
        form,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      api.saveForm("advisor", tenant, id, { expectedVersion: 1, form }),
    ).rejects.toMatchObject({ status: 403 });
    await api.saveForm("owner", tenant, id, {
      expectedVersion: 1,
      form: { ...form, name: "Updated" },
    });
    await expect(
      api.saveForm("owner", tenant, id, { expectedVersion: 1, form }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      api.deleteForm("owner", tenant, id, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await api.deleteForm("owner", tenant, id, { expectedVersion: 2 });
    await api.deleteType("owner", tenant, type.id);
    await api.deleteType("owner", tenant, types[0].id);
    expect(
      (await api.listTypes("owner", tenant)).items.map((t) => t.name),
    ).toEqual(["Technical"]);
    expect(
      (await api.createType("owner", tenant, { name: "Marketing" })).id,
    ).toBe(types[0].id);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM sophia_runtime.lead_forms_audit WHERE customer_id=$1",
          [tenant],
        )
      ).rows[0].n,
    ).toBe(7);
  });
  test("RLS is forced and the runtime role cannot change audit history", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (await db.query("SELECT * FROM sophia_runtime.lead_form_types")).rows,
      ).toEqual([]);
      await expect(
        db.query(
          "UPDATE sophia_runtime.lead_forms_audit SET action='form_deleted'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  });
});
