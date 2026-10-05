import { describe, expect, it, jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { OpenForAustraliaStudentsService } from "./open-for-australia-students.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

function principal(role: "chief_executive" | "operations" | "advisor") {
  return {
    identityUserId: "advisor-1",
    tenantId,
    externalCompanyId: "22222222-2222-4222-8222-222222222222",
    entitlementId: "33333333-3333-4333-8333-333333333333",
    role,
    authorizationRevision: 1,
  } as const;
}

function harness() {
  const query = jest.fn().mockResolvedValue({
    rows: [{
      student_id: "44444444-4444-4444-8444-444444444444",
      student_reference: "OFA-001",
      legal_name: "Synthetic Student",
      preferred_name: "Student",
      email: "synthetic.student@example.invalid",
      current_stage: "new_application",
      status: "active",
      college_name: "Synthetic College",
      advisor_identity_user_id: "advisor-1",
      total_count: 1,
    }],
    rowCount: 1,
  });
  const database = {
    tenantReadTransaction: jest.fn(async (
      _tenantId: string,
      work: (client: { query: typeof query }) => Promise<unknown>,
    ) => work({ query })),
  };
  return { service: new OpenForAustraliaStudentsService(database as never), database, query };
}

describe("OpenForAustraliaStudentsService", () => {
  it("returns only approved list fields from a tenant read transaction", async () => {
    const { service, database } = harness();
    await expect(service.list(principal("operations"), { page: "1", limit: "20" }))
      .resolves.toEqual({
        students: [{
          studentId: "44444444-4444-4444-8444-444444444444",
          studentReference: "OFA-001",
          legalName: "Synthetic Student",
          preferredName: "Student",
          email: "synthetic.student@example.invalid",
          currentStage: "new_application",
          status: "active",
          collegeName: "Synthetic College",
          advisorAssigned: true,
          maskedFields: [],
        }],
        page: 1,
        limit: 20,
        total: 1,
      });
    expect(database.tenantReadTransaction).toHaveBeenCalledWith(tenantId, expect.any(Function));
  });

  it("supports assignment-state filtering without exposing an advisor identifier", async () => {
    const { service, query } = harness();
    const result = await service.list(principal("operations"), { advisor: "unassigned" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("advisor_identity_user_id IS NULL"),
      expect.any(Array),
    );
    expect(result.students[0]).not.toHaveProperty("advisorIdentityUserId");
  });

  it("forces advisor assignment scope and ignores a caller-supplied advisor filter", async () => {
    const { service, query } = harness();
    await service.list(principal("advisor"), { advisorIdentityUserId: "somebody-else" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("advisor_identity_user_id = $2"),
      expect.arrayContaining([tenantId, "advisor-1"]),
    );
    expect(query.mock.calls[0][1]).not.toContain("somebody-else");
  });

  it("rejects unbounded or unknown query input", async () => {
    const { service } = harness();
    await expect(service.list(principal("operations"), {
      limit: 101,
      unexpected: "value",
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
