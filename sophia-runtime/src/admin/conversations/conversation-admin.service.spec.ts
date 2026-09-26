import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { ConversationAdminService } from "./conversation-admin.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("ConversationAdminService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("lists only tenant-scoped structural metadata with bounded cursor filters", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      session_id: sessionId, status: "closed", started_at: "2026-09-25T01:00:00.000Z",
      ended_at: "2026-09-25T01:05:00.000Z", channel: "voice", outcome: "completed",
      escalation_case_id: null, escalation_status: null, tool_call_count: 1,
    }] });
    const service = serviceWith(query);
    const result = await service.list(tenantId, { limit: 25, channel: "voice", outcome: "completed" });
    expect(result.conversations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("payload");
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("s.customer_id = $1");
    expect(sql).toContain("ORDER BY s.started_at DESC, s.session_id DESC");
    expect(query.mock.calls[0]?.[1]).toEqual([tenantId, "voice", "completed", 26]);
  });

  it("builds a stable metadata timeline without returning raw payloads", async () => {
    const query = jest.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("FROM sophia_runtime.sessions s")) return { rows: [{
        session_id: sessionId, status: "closed", runtime_api_version: "v2", channel: "voice", outcome: "completed",
        started_at: "2026-09-25T01:00:00.000Z", ended_at: "2026-09-25T01:05:00.000Z",
      }] };
      if (sql.includes("FROM sophia_runtime.tool_calls")) return { rows: [{ id: "tool-1", tool_name: "safe.tool",
        status: "succeeded", occurred_at: "2026-09-25T01:02:00.000Z" }] };
      if (sql.includes("FROM sophia_runtime.action_reviews")) return { rows: [] };
      if (sql.includes("FROM sophia_runtime.events")) return { rows: [{ id: "event-1", event_type: "turn.completed",
        occurred_at: "2026-09-25T01:01:00.000Z" }] };
      if (sql.includes("FROM sophia_runtime.workflow_run_references")) return { rows: [] };
      if (sql.includes("FROM sophia_runtime.escalation_cases")) return { rows: [] };
      return { rows: [] };
    });
    const result = await serviceWith(query).detail(tenantId, sessionId);
    expect(result.timeline.map((item) => item.kind)).toEqual([
      "session.started", "event.turn.completed", "tool.succeeded", "session.ended",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret transcript");
    expect(result.transcript.status).toBe("unavailable_not_recorded");
    expect(result.audio.status).toBe("unavailable_not_recorded");
  });

  it("redacts credential-shaped fields at the separately protected content boundary", async () => {
    const query = jest.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("FROM sophia_runtime.sessions s")) return { rows: [{ session_id: sessionId, status: "closed",
        started_at: new Date(), ended_at: new Date(), channel: "voice", outcome: "completed" }] };
      if (sql.includes("FROM sophia_runtime.session_privacy_controls")) return { rows: [{
        full_transcript_persistence_enabled: false, raw_audio_recording_enabled: false,
        active_hold: false, content_retention_days: null, review_retention_days: null,
      }] };
      if (sql.includes("FROM sophia_runtime.tool_calls")) return { rows: [{ id: "tool-1", tool_name: "safe.tool",
        input: { apiKey: "secret", publicValue: "visible" }, occurred_at: "2026-09-25T01:01:00.000Z" }] };
      return { rows: [] };
    });
    const result = await serviceWith(query).content(tenantId, sessionId);
    expect(result.operationalContent.status).toBe("available");
    expect(result.operationalContent.items[0].content).toEqual(expect.objectContaining({
      input: { apiKey: "[REDACTED]", publicValue: "visible" },
    }));
    expect(result.transcript.status).toBe("unavailable_not_recorded");
  });

  it("stores a note without echoing its sensitive body and records an audit receipt", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ conversation_operator_note_id: "note-1",
      created_at: "2026-09-25T01:00:00.000Z" }] });
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = serviceWith(query, audit);
    const result = await service.addNote(tenantId, sessionId, "operator-1", { note: "Call the visitor" });
    expect(result).not.toHaveProperty("note");
    expect(String(query.mock.calls[0]?.[0])).toContain("s.customer_id = $1 AND s.session_id = $2");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      permission: "conversations.annotate", resourceId: sessionId,
    }), expect.anything());
  });

  it("never allows export authority alone to create a raw-content export", async () => {
    const service = serviceWith(jest.fn());
    await expect(service.createExport(tenantId, sessionId, "operator-1",
      { format: "json", scope: "content", maxItems: 100 }, false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("stores an expiring metadata manifest without duplicating conversation content", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ conversation_export_job_id: "export-1", status: "ready",
      export_scope: "metadata", initial_item_count: 2, as_of: "2026-09-25T01:00:00.000Z",
      expires_at: "2026-09-26T01:00:00.000Z" }] });
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = serviceWith(query, audit);
    jest.spyOn(service, "detail").mockResolvedValue({
      session: { session_id: sessionId },
      timeline: [{ id: "start", occurredAt: "2026-09-25T00:00:00.000Z" },
        { id: "future", occurredAt: "2099-01-01T00:00:00.000Z" }],
    } as never);
    const result = await service.createExport(tenantId, sessionId, "operator-1",
      { format: "json", scope: "metadata", maxItems: 10 }, false);
    expect(result).toEqual(expect.objectContaining({ conversation_export_job_id: "export-1" }));
    expect(String(query.mock.calls[0]?.[0])).toContain("conversation_export_jobs");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("document");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "admin.conversation_export.created", permission: "conversations.export",
    }), expect.anything());
  });

  it("rejects downloading another operator's content manifest without content permission", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ conversation_export_job_id: "export-1",
      session_id: sessionId, export_scope: "content", status: "ready", as_of: new Date().toISOString(),
      max_items: 100, initial_item_count: 2, expires_at: new Date(Date.now() + 60_000).toISOString() }] });
    const service = serviceWith(query);
    await expect(service.downloadExport(tenantId, "33333333-3333-4333-8333-333333333333",
      "metadata-operator", false)).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

function serviceWith(query: jest.Mock, audit: { record: jest.Mock } = { record: jest.fn() }) {
  const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) =>
    work({ query } as never)) };
  return new ConversationAdminService(database as never, audit as never);
}
