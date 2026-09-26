import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PrivacyExecutionService } from "./privacy-execution.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

describe("PrivacyExecutionService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("redacts Runtime-controlled stores and leaves unverified backups blocked", async () => {
    const targets = new Map([
      ["runtime_session_content", "pending"], ["runtime_review_payloads", "pending"],
      ["runtime_operational_metadata", "pending"], ["business_manager_documents", "pending"],
      ["provider_owned_data", "pending"], ["backups", "pending"],
    ]);
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM sophia_runtime.privacy_subject_requests") && sql.includes("FOR UPDATE")) return { rows: [request()] };
      if (sql.includes("FROM sophia_runtime.privacy_legal_holds")) return { rows: [] };
      if (sql.includes("SELECT session_id, status, ai_provider")) return { rows: [{ session_id: sessionId, status: "closed", ai_provider: "none", avatar_provider: "none" }] };
      if (sql.includes("FROM sophia_runtime.provider_session_allocations") && sql.includes("SELECT stage")) return { rows: [{ stage: "released", provider_snapshot: {} }] };
      if (sql.includes("SELECT DISTINCT command_id")) return { rows: [] };
      if (sql.includes("UPDATE sophia_runtime.tool_calls")) return result(2);
      if (sql.includes("UPDATE sophia_runtime.events")) return result(3);
      if (sql.includes("UPDATE sophia_runtime.sessions")) return result(1);
      if (sql.includes("UPDATE sophia_runtime.action_reviews")) return result(1);
      if (sql.includes("UPDATE sophia_runtime.provider_session_allocations")) return result(1);
      if (sql.includes("UPDATE sophia_runtime.escalation_cases")) return result(0);
      if (sql.includes("UPDATE sophia_runtime.privacy_subject_request_targets")) {
        const key = String(params[2]); const current = targets.get(key);
        if (!["completed", "not_applicable"].includes(String(current))) targets.set(key, String(params[3]));
        return result(1);
      }
      if (sql.includes("SELECT target_key, status, evidence_digest")) {
        return { rows: [...targets].sort().map(([target_key, status]) => ({ target_key, status, evidence_digest: "a".repeat(64), detail: null })) };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = new PrivacyExecutionService(database(query) as never);
    const output = await service.execute(tenantId, requestId, "operator-1");
    expect(output.status).toBe("blocked");
    expect(targets.get("runtime_session_content")).toBe("completed");
    expect(targets.get("runtime_review_payloads")).toBe("completed");
    expect(targets.get("runtime_operational_metadata")).toBe("completed");
    expect(targets.get("business_manager_documents")).toBe("not_applicable");
    expect(targets.get("provider_owned_data")).toBe("not_applicable");
    expect(targets.get("backups")).toBe("blocked");

    const completed = await service.recordExternalEvidence(tenantId, requestId, "backups", "operator-1", {
      status: "not_applicable", evidenceReference: "backup-probe:no-synthetic-copy",
      evidenceDigest: "b".repeat(64), detail: "The rollback-only synthetic subject was never included in a backup.",
    });
    expect(completed.status).toBe("completed");
    expect(targets.get("backups")).toBe("not_applicable");
  });

  it("stops before mutation when an active legal hold exists", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("privacy_subject_requests") && sql.includes("FOR UPDATE")) return { rows: [request()] };
      if (sql.includes("privacy_legal_holds")) return { rows: [{ exists: 1 }] };
      return { rows: [] };
    });
    const service = new PrivacyExecutionService(database(query) as never);
    await expect(service.execute(tenantId, requestId, "operator-1")).rejects.toThrow("active legal hold");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE sophia_runtime.tool_calls"))).toBe(false);
  });

  it("uses only the approved retention duration and excludes held sessions", async () => {
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM sophia_runtime.privacy_retention_policies")) return { rows: [{
        privacy_retention_policy_id: "44444444-4444-4444-8444-444444444444",
        dataset_key: "session_content", retention_days: 30,
      }] };
      if (sql.includes("FROM sophia_runtime.sessions s")) return { rows: [
        { session_id: sessionId, subject_reference_digest: "a".repeat(64), held: true, cleanup_safe: true },
        { session_id: "55555555-5555-4555-8555-555555555555", subject_reference_digest: "b".repeat(64), held: false, cleanup_safe: true },
      ] };
      if (sql.includes("UPDATE sophia_runtime.tool_calls")) return result(0);
      if (sql.includes("UPDATE sophia_runtime.events")) return result(0);
      if (sql.includes("UPDATE sophia_runtime.sessions")) {
        expect(params[1]).toEqual(["55555555-5555-4555-8555-555555555555"]);
        return result(1);
      }
      if (sql.includes("INSERT INTO sophia_runtime.privacy_retention_runs")) return { rows: [{ privacy_retention_run_id: "66666666-6666-4666-8666-666666666666" }] };
      return { rows: [], rowCount: 0 };
    });
    const service = new PrivacyExecutionService(database(query) as never);
    const output = await service.retentionRun(tenantId, "operator-1", {
      privacyRetentionPolicyId: "44444444-4444-4444-8444-444444444444", execute: true, limit: 100,
    });
    expect(output).toMatchObject({ status: "completed", heldCount: 1, processedCount: 1 });
    const candidateCall = query.mock.calls.find(([sql]) => String(sql).includes("FROM sophia_runtime.sessions s"));
    expect(new Date(String(candidateCall?.[1]?.[1])).getTime()).toBeGreaterThan(Date.now() - 31 * 86_400_000);
  });
});

function request() {
  return {
    privacy_subject_request_id: requestId, request_type: "deletion", subject_reference_digest: "a".repeat(64),
    selectors: { sessionIds: [sessionId] }, verification_status: "verified", status: "ready", processing_started_at: null,
  };
}
function result(rowCount: number) { return { rows: rowCount ? [{}] : [], rowCount }; }
function database(query: jest.Mock) {
  return { tenantTransaction: jest.fn((_tenant: string, work: (client: { query: jest.Mock }) => unknown) => work({ query })) };
}
