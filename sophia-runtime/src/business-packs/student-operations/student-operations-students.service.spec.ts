import { describe, expect, it, jest } from "@jest/globals";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { StudentOperationsStudentsService } from "./student-operations-students.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

function principal(role: "chief_executive" | "operations" | "advisor") {
  return {
    identityUserId: "55555555-5555-4555-8555-555555555555",
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
      student_reference: "STU-001",
      legal_name: "Synthetic Student",
      preferred_name: "Student",
      email: "synthetic.student@example.invalid",
      current_stage: "new_application",
      status: "active",
      college_name: "Synthetic College",
      advisor_identity_user_id: "advisor-1",
      record_version: 1,
      created_at: "2026-10-08T00:00:00.000Z",
      updated_at: "2026-10-08T00:00:00.000Z",
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
  return { service: new StudentOperationsStudentsService(database as never), database, query };
}

describe("StudentOperationsStudentsService", () => {
  it("returns only approved list fields from a tenant read transaction", async () => {
    const { service, database } = harness();
    await expect(service.list(principal("operations"), { page: "1", limit: "20" }))
      .resolves.toEqual({
        students: [{
          studentId: "44444444-4444-4444-8444-444444444444",
          studentReference: "STU-001",
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
      expect.arrayContaining([tenantId, "55555555-5555-4555-8555-555555555555"]),
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

  it("loads all dashboard counts with one tenant-scoped aggregate query", async () => {
    const { service, query } = harness();
    query.mockResolvedValueOnce({
      rows: [{ total: 11, active: 8, new_applications: 3, action_required: 2, on_hold: 1 }],
      rowCount: 1,
    });
    await expect(service.summary(principal("operations"))).resolves.toEqual({
      totalStudents: 11,
      activeStudents: 8,
      newApplications: 3,
      actionRequired: 2,
      onHold: 1,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("count(*) FILTER"),
      [tenantId],
    );
  });

  it("scopes advisor dashboard counts to the signed-in advisor", async () => {
    const { service, query } = harness();
    query.mockResolvedValueOnce({
      rows: [{ total: 1, active: 1, new_applications: 1, action_required: 0, on_hold: 0 }],
      rowCount: 1,
    });
    await service.summary(principal("advisor"));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("advisor_identity_user_id = $2"),
      [tenantId, "55555555-5555-4555-8555-555555555555"],
    );
  });

  it("loads advisor identities using the entitlement role_key column", async () => {
    const { service, query } = harness();
    query.mockResolvedValueOnce({
      rows: [{ identity_user_id: "advisor-1" }],
      rowCount: 1,
    });

    await expect(service.advisors(principal("operations"))).resolves.toEqual({
      advisorIdentityUserIds: ["advisor-1"],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("role_key = 'advisor'"),
      [tenantId],
    );
    expect(query.mock.calls[0][0]).not.toContain("AND role = 'advisor'");
  });

  it("denies student writes to advisors before opening a transaction", async () => {
    const { service, database } = harness();
    await expect(service.create(principal("advisor"), {}, "write-key-001"))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect((database as any).tenantTransaction).toBeUndefined();
  });

  it("creates a student once and records an audit event without copied PII", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("student_operations_write_requests") && sql.includes("INSERT INTO")) {
        return { rows: [{ idempotency_key: "write-key-001" }], rowCount: 1 };
      }
      if (sql.includes("student_operations_students") && sql.includes("INSERT INTO")) {
        return { rows: [{
          student_id: "44444444-4444-4444-8444-444444444444",
          student_reference: "STU-001",
          legal_name: "Synthetic Student",
          preferred_name: null,
          email: "synthetic@example.invalid",
          current_stage: "new_application",
          status: "active",
          college_name: null,
          advisor_identity_user_id: null,
          record_version: 1,
          created_at: "2026-10-08T00:00:00.000Z",
          updated_at: "2026-10-08T00:00:00.000Z",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const database = {
      tenantTransaction: jest.fn(async (_tenantId: string, work: any) => work({ query })),
    };
    const service = new StudentOperationsStudentsService(database as never);
    await expect(service.create(principal("operations"), {
      studentReference: "STU-001",
      legalName: "Synthetic Student",
      preferredName: null,
      email: "Synthetic@Example.Invalid",
      currentStage: "new_application",
      status: "active",
      advisorIdentityUserId: null,
      collegeName: null,
    }, "write-key-001", "correlation-1")).resolves.toEqual(expect.objectContaining({
      studentId: "44444444-4444-4444-8444-444444444444",
      email: "synthetic@example.invalid",
      recordVersion: 1,
    }));
    const auditCall = query.mock.calls.find(([sql]) => sql.includes("student_operations_student_audit_events"));
    expect(auditCall?.[1]).toEqual([
      tenantId,
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "student.created",
      1,
      expect.arrayContaining(["legalName", "email"]),
      "correlation-1",
    ]);
    expect(JSON.stringify(auditCall)).not.toContain("Synthetic Student");
  });

  it("creates and links a reviewed Xero candidate in the same tenant transaction", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("student_operations_write_requests") && sql.includes("INSERT INTO")) {
        return { rows: [{ idempotency_key: "write-key-xero" }], rowCount: 1 };
      }
      if (sql.includes("student_operations_students") && sql.includes("INSERT INTO")) {
        return { rows: [{
          student_id: "44444444-4444-4444-8444-444444444444",
          student_reference: "STU-XERO",
          legal_name: "Xero Candidate",
          preferred_name: null,
          email: "candidate@example.invalid",
          current_stage: "new_application",
          status: "active",
          college_name: null,
          advisor_identity_user_id: null,
          record_version: 1,
          created_at: "2026-10-10T00:00:00.000Z",
          updated_at: "2026-10-10T00:00:00.000Z",
        }], rowCount: 1 };
      }
      return { rows: [{ accepted: 1 }], rowCount: 1 };
    });
    const database = {
      tenantTransaction: jest.fn(async (_tenantId: string, work: any) => work({ query })),
    };
    const service = new StudentOperationsStudentsService(database as never);

    await service.create(principal("chief_executive"), {
      studentReference: "STU-XERO", legalName: "Xero Candidate",
      preferredName: null, email: "candidate@example.invalid",
      currentStage: "new_application", status: "active",
      advisorIdentityUserId: null, collegeName: null,
      xeroCandidateSource: {
        connectionId: "66666666-6666-4666-8666-666666666666",
        contactId: "77777777-7777-4777-8777-777777777777",
      },
    }, "write-key-xero");

    expect(database.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("student_operations_xero_candidate_reviews"),
      [
        tenantId,
        "66666666-6666-4666-8666-666666666666",
        "77777777-7777-4777-8777-777777777777",
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
      ],
    );
  });

  it("rejects duplicate student references", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("student_operations_write_requests")) {
        return { rows: [{ idempotency_key: "write-key-002" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = new StudentOperationsStudentsService({
      tenantTransaction: async (_tenantId: string, work: any) => work({ query }),
    } as never);
    await expect(service.create(principal("chief_executive"), {
      studentReference: "STU-001", legalName: "Synthetic Student",
      preferredName: null, email: "synthetic@example.invalid",
      currentStage: "new_application", status: "active",
      advisorIdentityUserId: null, collegeName: null,
    }, "write-key-002")).rejects.toBeInstanceOf(ConflictException);
  });

  it("returns a completed idempotent response without inserting another student", async () => {
    const studentId = "44444444-4444-4444-8444-444444444444";
    const query = jest.fn();
    const database = {
      tenantTransaction: async (_tenantId: string, work: any) => work({ query }),
    };
    const service = new StudentOperationsStudentsService(database as never);
    const input = {
      studentReference: "STU-001", legalName: "Synthetic Student",
      preferredName: null, email: "synthetic@example.invalid",
      currentStage: "new_application", status: "active",
      advisorIdentityUserId: null, collegeName: null,
    };
    const crypto = await import("node:crypto");
    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ operation: "student.create", value: input })).digest("hex");
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          operation: "student.create",
          request_fingerprint: fingerprint,
          response: { studentId, recordVersion: 1 },
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{
        student_id: studentId,
        student_reference: "STU-001",
        legal_name: "Synthetic Student",
        preferred_name: null,
        email: "synthetic@example.invalid",
        current_stage: "new_application",
        status: "active",
        college_name: null,
        advisor_identity_user_id: null,
        record_version: 1,
        created_at: "2026-10-08T00:00:00.000Z",
        updated_at: "2026-10-08T00:00:00.000Z",
      }], rowCount: 1 });
    await expect(service.create(principal("operations"), input, "write-key-003"))
      .resolves.toEqual(expect.objectContaining({
        studentId, studentReference: "STU-001", idempotentReplay: true,
      }));
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects an update based on a stale record version", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("student_operations_write_requests")) {
        return { rows: [{ idempotency_key: "write-key-004" }], rowCount: 1 };
      }
      return { rows: [{
        student_id: "44444444-4444-4444-8444-444444444444",
        student_reference: "STU-001",
        legal_name: "Synthetic Student",
        preferred_name: null,
        email: "synthetic@example.invalid",
        current_stage: "new_application",
        status: "active",
        college_name: null,
        advisor_identity_user_id: null,
        record_version: 2,
        created_at: "2026-10-08T00:00:00.000Z",
        updated_at: "2026-10-08T00:00:00.000Z",
      }], rowCount: 1 };
    });
    const service = new StudentOperationsStudentsService({
      tenantTransaction: async (_tenantId: string, work: any) => work({ query }),
    } as never);
    await expect(service.update(
      principal("operations"),
      "44444444-4444-4444-8444-444444444444",
      {
        studentReference: "STU-001", legalName: "Changed Student",
        preferredName: null, email: "synthetic@example.invalid",
        currentStage: "new_application", status: "active",
        advisorIdentityUserId: null, collegeName: null, recordVersion: 1,
      },
      "write-key-004",
    )).rejects.toBeInstanceOf(ConflictException);
  });
});
