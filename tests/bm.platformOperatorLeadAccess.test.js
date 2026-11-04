import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const tenant = "11111111-1111-4111-8111-111111111111";
const company = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
let scopeAllowed = true;
let managerAllowed = true;

const query = jest.fn(async (sql, params = []) => {
  const statement = String(sql);
  if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
    return { rows: [] };
  }
  if (statement.includes("SELECT c.customer_id FROM public.users")) {
    expect(statement).toContain("u.type::text='admin'");
    expect(statement).toContain("assignment.operator_company_id=u.company_id");
    expect(params).toEqual([actor, company]);
    return { rows: scopeAllowed ? [{ customer_id: tenant }] : [] };
  }
  if (statement.startsWith("SET LOCAL ROLE") || statement.includes("set_config")) {
    return { rows: [] };
  }
  if (statement.includes("AS allowed")) {
    expect(statement).toContain("assignment.operator_company_id=$3");
    expect(params).toEqual([tenant, actor, company]);
    return { rows: [{ allowed: managerAllowed }] };
  }
  if (statement.includes("to_regclass")) {
    return { rows: [{ installed: true }] };
  }
  throw new Error(`Unexpected query in platform operator access test: ${statement}`);
});
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));

jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { connect },
}));

const settings = await import("../src/services/leads/assistant-settings.service.js");

describe("platform operator Leads access", () => {
  beforeEach(() => {
    scopeAllowed = true;
    managerAllowed = true;
    query.mockClear();
    connect.mockClear();
    release.mockClear();
  });

  test("uses the verified internal company as the platform operator boundary", async () => {
    await expect(settings.canManageSettings(actor, company)).resolves.toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("fails closed when the operator scope or active assignment is absent", async () => {
    scopeAllowed = false;
    await expect(settings.canManageSettings(actor, company)).resolves.toBe(false);

    scopeAllowed = true;
    managerAllowed = false;
    await expect(settings.canManageSettings(actor, company)).resolves.toBe(false);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
