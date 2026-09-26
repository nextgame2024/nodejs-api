import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { CreateKnowledgeRevisionSchema } from "./knowledge.contracts.js";
import { KnowledgeService } from "./knowledge.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";

describe("approved knowledge lifecycle", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("accepts only bounded declared text formats", () => {
    expect(CreateKnowledgeRevisionSchema.parse({
      sourceType: "managed_text", mediaType: "text/plain", contentText: "Approved opening hours",
    }).sourceType).toBe("managed_text");
    expect(() => CreateKnowledgeRevisionSchema.parse({
      sourceType: "managed_text", mediaType: "text/html", contentText: "<script>alert(1)</script>",
    })).toThrow();
    expect(() => CreateKnowledgeRevisionSchema.parse({
      sourceType: "managed_text", mediaType: "text/plain", contentText: `safe\u0000binary`,
    })).toThrow("unsupported control characters");
    expect(() => CreateKnowledgeRevisionSchema.parse({
      sourceType: "managed_text", mediaType: "text/plain", contentText: "x".repeat(262_145),
    })).toThrow();
    expect(() => CreateKnowledgeRevisionSchema.parse({
      sourceType: "managed_text", mediaType: "text/plain", contentText: "😀".repeat(70_000),
    })).toThrow("256 KiB");
  });

  it("rejects URL-shaped connector references", () => {
    expect(() => CreateKnowledgeRevisionSchema.parse({
      sourceType: "connector_reference",
      connectorBindingId: "44444444-4444-4444-8444-444444444444",
      connectorObjectRef: "https://internal.example/document",
    })).toThrow("opaque identifiers");
  });

  it("does not fetch or mark connector references ready without an approved adapter", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
      knowledge_revision_id: revisionId,
      knowledge_source_id: sourceId,
      source_type: "connector_reference",
      content_text: null,
      ingestion_status: "pending",
      status: "draft",
      title: "CRM policy",
      }], rowCount: 1 });
    const client = { query } as unknown as PoolClient;
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)) };
    const service = new KnowledgeService(database as never, { record: jest.fn() } as never, {} as never);
    await expect(service.ingest(tenantId, revisionId, "actor-1", { idempotencyKey: "connector-attempt-1" }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns the existing ingestion job for an idempotent retry", async () => {
    const existing = { knowledge_ingestion_job_id: "55555555-5555-4555-8555-555555555555", knowledge_revision_id: revisionId, status: "succeeded", attempt_count: 1 };
    const client = { query: jest.fn().mockResolvedValue({ rows: [existing], rowCount: 1 }) } as unknown as PoolClient;
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)) };
    const service = new KnowledgeService(database as never, { record: jest.fn() } as never, {} as never);
    await expect(service.ingest(tenantId, revisionId, "actor-1", { idempotencyKey: "safe-retry-0001" })).resolves.toEqual({
      knowledgeIngestionJobId: existing.knowledge_ingestion_job_id,
      status: "succeeded",
      attemptCount: 1,
      errorCode: undefined,
      errorMessage: undefined,
    });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("lists only enabled tenant knowledge capability bindings", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)) };
    const service = new KnowledgeService(database as never, { record: jest.fn() } as never, {} as never);
    await expect(service.listKnowledgeBindings(tenantId)).resolves.toEqual({ bindings: [] });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("b.capability_key = 'knowledge' AND b.enabled = true"), [tenantId]);
  });

  it("does not expose revision content outside the tenant-scoped lookup", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)) };
    const service = new KnowledgeService(database as never, { record: jest.fn() } as never, {} as never);
    await expect(service.getRevision(tenantId, revisionId)).rejects.toThrow("Knowledge revision not found");
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("r.customer_id = $2"), [revisionId, tenantId]);
  });
});
