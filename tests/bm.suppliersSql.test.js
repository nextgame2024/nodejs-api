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
const url = process.env.LOCAL_SUPPLIERS_ADMIN_URL;
if (url && !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Local database only");
const suite = url ? describe : describe.skip;
const name = "codex_suppliers_" + randomUUID().replaceAll("-", "");
const admin = new Pool({
  connectionString: url ?? "postgresql://localhost:1/postgres",
});
const dbUrl = new URL(url ?? "postgresql://localhost:1/postgres");
dbUrl.pathname = "/" + name;
const pool = new Pool({ connectionString: dbUrl.toString() });
jest.unstable_mockModule("../src/config/db.js", () => ({ default: pool }));
const service = await import("../src/services/bm.suppliers.service.js");
const company = randomUUID(),
  other = randomUUID(),
  user = randomUUID(),
  legacyProduct = randomUUID();
suite("Supplier type persistence and register paging", () => {
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${name}`);
    await pool.query(`CREATE TABLE bm_suppliers(supplier_id uuid PRIMARY KEY,company_id uuid NOT NULL,user_id uuid,supplier_name text,address text,email text,cel text,tel text,notes text,status text DEFAULT 'active',createdat timestamptz DEFAULT now(),updatedat timestamptz DEFAULT now());
      CREATE TABLE bm_supplier_contacts(company_id uuid,supplier_id uuid);
      CREATE TABLE bm_supplier_materials(company_id uuid,supplier_id uuid);
      CREATE TABLE bm_project_types_materials(company_id uuid,supplier_id uuid);
      CREATE TABLE bm_project_materials(company_id uuid,supplier_id uuid);`);
    await pool.query(
      "INSERT INTO bm_suppliers(supplier_id,company_id,supplier_name) VALUES($1,$2,$3)",
      [legacyProduct, company, "Legacy"],
    );
    await pool.query("INSERT INTO bm_supplier_materials VALUES($1,$2)", [
      company,
      legacyProduct,
    ]);
    await pool.query(
      await readFile(
        new URL("../scripts/sql/bm_supplier_type.sql", import.meta.url),
        "utf8",
      ),
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  test("defaults new suppliers to Services and preserves existing product links on repeat migration", async () => {
    expect(
      (await service.getSupplier(company, legacyProduct)).supplierType,
    ).toBe("products");
    const row = await service.createSupplier(company, user, {
      supplier_name: "Alex",
      email: "a@example.test",
    });
    expect(row.supplierType).toBe("services");
    await service.updateSupplier(company, legacyProduct, {
      supplier_type: "services",
    });
    await pool.query(
      await readFile(
        new URL("../scripts/sql/bm_supplier_type.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (await service.getSupplier(company, legacyProduct)).supplierType,
    ).toBe("services");
    await service.updateSupplier(company, row.supplierId, {
      supplier_type: "products",
    });
    expect(
      (await service.getSupplier(company, row.supplierId)).supplierType,
    ).toBe("products");
    expect(
      (
        await service.updateSupplier(company, row.supplierId, {
          notes: "Update",
        })
      ).supplierType,
    ).toBe("products");
  });
  test("rejects invalid types, and prevents cross-company changes", async () => {
    expect(() =>
      service.createSupplier(company, user, {
        supplier_name: "Bad",
        supplier_type: "invalid",
      }),
    ).toThrow("Select Services or Products");
    expect(
      await service.updateSupplier(other, legacyProduct, {
        supplier_type: "products",
      }),
    ).toBeUndefined();
    await expect(
      pool.query(
        "UPDATE bm_suppliers SET supplier_type=$1 WHERE supplier_id=$2",
        ["invalid", legacyProduct],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  test("sorts the entire company collection before paging, with stable ties and matching search counts", async () => {
    await service.createSupplier(other, user, { supplier_name: "Hidden" });
    for (const supplier_name of ["Zed", "Bea", "Bea"])
      await service.createSupplier(company, user, { supplier_name });
    const first = await service.listSuppliers(company, {
      page: 1,
      limit: 2,
      sort: "name",
      direction: "desc",
    });
    const next = await service.listSuppliers(company, {
      page: 2,
      limit: 2,
      sort: "name",
      direction: "desc",
    });
    expect(first.total).toBe(5);
    expect(first.suppliers.map((x) => x.supplierName)).toEqual([
      "Zed",
      "Legacy",
    ]);
    expect(next.suppliers.map((x) => x.supplierName)).toEqual(["Bea", "Bea"]);
    expect(next.suppliers[0].supplierId < next.suppliers[1].supplierId).toBe(
      true,
    );
    const search = await service.listSuppliers(company, {
      q: "products",
      page: 1,
      limit: 25,
      sort: "type",
    });
    expect(search.total).toBe(1);
    expect(search.suppliers).toHaveLength(1);
    const safe = await service.listSuppliers(company, {
      sort: "name; DROP TABLE bm_suppliers",
      direction: "desc; DROP TABLE bm_suppliers",
    });
    expect(safe.suppliers[0].supplierName).toBe("Alex");
  });
});
