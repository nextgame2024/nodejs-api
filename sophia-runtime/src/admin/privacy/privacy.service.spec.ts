import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PrivacyService, subjectReferenceDigest } from "./privacy.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("PrivacyService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("stores only a tenant-bound digest of the opaque subject reference and creates every ownership target", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT session_id")) return { rows: [{ session_id: sessionId }] };
      if (sql.includes("privacy_subject_requests") && sql.includes("INSERT")) {
        return { rows: [{ privacy_subject_request_id: "33333333-3333-4333-8333-333333333333" }] };
      }
      return { rows: [] };
    });
    const service = new PrivacyService(database(query) as never);
    const subjectReference = "opaque_Subject_0123456789";

    const result = await service.createSubjectRequest(tenantId, "operator-1", {
      requestType: "deletion", subjectReference, sessionIds: [sessionId],
    });

    expect(result).toMatchObject({ verificationStatus: "pending", status: "pending_verification" });
    expect(queries).toHaveLength(10);
    expect(queries.flatMap((item) => item.params)).not.toContain(subjectReference);
    expect(queries[1].params).toContain(subjectReferenceDigest(tenantId, subjectReference));
    expect(queries.filter((item) => item.sql.includes("privacy_subject_request_targets"))
      .map((item) => item.params[2])).toEqual([
      "runtime_session_content", "runtime_review_payloads", "runtime_operational_metadata",
      "business_manager_documents", "provider_owned_data", "backups",
    ]);
  });

  it("refuses a subject request when a selected session is not tenant-owned", async () => {
    const service = new PrivacyService(database(jest.fn().mockResolvedValue({ rows: [] })) as never);
    await expect(service.createSubjectRequest(tenantId, "operator-1", {
      requestType: "deletion", subjectReference: "opaque_Subject_0123456789", sessionIds: [sessionId],
    })).rejects.toThrow("unknown or outside this tenant");
  });

  it("requires an independent identified reviewer for an approved legal review", async () => {
    const query = jest.fn(); const service = new PrivacyService(database(query) as never);
    await expect(service.updateLegalReview(tenantId, "privacy_notice", "same-reviewer", {
      status: "approved", reviewReference: "counsel-matter-123", reviewerIdentity: "same-reviewer",
    })).rejects.toThrow("independent reviewer");
    expect(query).not.toHaveBeenCalled();
  });

  it("does not report retention automation enabled merely because policies exist", async () => {
    const rows = [
      { rows: [] },
      { rows: ["session_content", "review_payloads", "generated_personal_documents", "provider_data", "backups", "audit_evidence"]
          .map((dataset_key) => ({ dataset_key, status: "approved" })) },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ];
    const service = new PrivacyService(database(jest.fn(async () => rows.shift())) as never);
    const result = await service.overview(tenantId);
    expect(result.retentionAutomation).toMatchObject({
      enabled: false, status: "policies_recorded_execution_not_enabled",
    });
    expect(result.legalReviews).toHaveLength(8);
    expect(result.legalReviews.every((review) => review.status === "required")).toBe(true);
  });
});

function database(query: jest.Mock) {
  return { tenantTransaction: jest.fn((_tenantId: string, work: (client: { query: jest.Mock }) => unknown) => work({ query })) };
}
