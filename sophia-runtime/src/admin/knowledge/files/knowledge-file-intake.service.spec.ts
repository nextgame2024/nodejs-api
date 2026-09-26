import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { InitiateKnowledgeFileSchema } from "../knowledge.contracts.js";
import { parseBoundedText } from "./bounded-text-parser.js";
import { KnowledgeFileIntakeService } from "./knowledge-file-intake.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const checksum = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("private knowledge file intake", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
    delete process.env.SOPHIA_KNOWLEDGE_S3_BUCKET;
    delete process.env.SOPHIA_KNOWLEDGE_SCANNER_URL;
  });

  it("allows only matching bounded text and markdown declarations", () => {
    expect(InitiateKnowledgeFileSchema.parse({ filename: "policy.md", mediaType: "text/markdown", contentLength: 24, checksumSha256Base64: checksum, idempotencyKey: "upload-policy-1" }).mediaType).toBe("text/markdown");
    expect(() => InitiateKnowledgeFileSchema.parse({ filename: "policy.pdf", mediaType: "application/pdf", contentLength: 24, checksumSha256Base64: checksum, idempotencyKey: "upload-policy-1" })).toThrow("Only .txt and .md");
    expect(() => InitiateKnowledgeFileSchema.parse({ filename: "policy.md", mediaType: "text/plain", contentLength: 24, checksumSha256Base64: checksum, idempotencyKey: "upload-policy-1" })).toThrow("do not match");
  });

  it("fails closed before creating an intake when storage or scanning is unavailable", async () => {
    const database = { tenantTransaction: jest.fn() };
    const storage = { readiness: jest.fn(async () => ({ ready: false, reason: "private_storage_not_configured" })) };
    const scanner = { readiness: jest.fn(async () => ({ ready: false, reason: "malware_scanner_not_configured" })) };
    const service = new KnowledgeFileIntakeService(database as never, {} as never, storage as never, scanner as never, {} as never);
    await expect(service.initiate(tenantId, sourceId, "actor-1", {
      filename: "policy.txt", mediaType: "text/plain", contentLength: 24,
      checksumSha256Base64: checksum, idempotencyKey: "upload-policy-1",
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(database.tenantTransaction).not.toHaveBeenCalled();
  });

  it("parses strict UTF-8 without executing or accepting binary controls", () => {
    expect(parseBoundedText({ bytes: new TextEncoder().encode("# Approved\r\nHours"), mediaType: "text/markdown", maxOutputBytes: 262_144 }))
      .toEqual({ text: "# Approved\nHours", parserVersion: "bounded-utf8-v1" });
    expect(() => parseBoundedText({ bytes: Uint8Array.from([0xff, 0xfe, 0x00]), mediaType: "text/plain", maxOutputBytes: 262_144 })).toThrow();
    expect(() => parseBoundedText({ bytes: new TextEncoder().encode("safe\u0000binary"), mediaType: "text/plain", maxOutputBytes: 262_144 })).toThrow("parser_content_invalid");
  });

  it("quarantines and deletes an upload whose object metadata changed", async () => {
    const intake = {
      knowledge_file_intake_id: "33333333-3333-4333-8333-333333333333", knowledge_source_id: sourceId,
      knowledge_revision_id: null, idempotency_key: "upload-policy-1", status: "awaiting_upload", object_key: "private/object",
      original_filename: "policy.txt", media_type: "text/plain", declared_bytes: 24,
      declared_sha256_base64: checksum, attempt_count: 0, created_by_identity: "actor-1",
    };
    const query = jest.fn(async (sql: string) => sql.includes("SELECT *")
      ? { rows: [intake], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const client = { query } as unknown as PoolClient;
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)) };
    const storage = { inspect: jest.fn(async () => ({ contentLength: 25, mediaType: "text/plain", checksumSha256Base64: checksum })), delete: jest.fn(async () => undefined) };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new KnowledgeFileIntakeService(database as never, audit as never, storage as never, {} as never, {} as never);
    await expect(service.complete(tenantId, intake.knowledge_file_intake_id, "actor-1")).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'quarantined'"), expect.any(Array));
    expect(storage.delete).toHaveBeenCalledWith("private/object");
  });

  it("never sends scanner-infected bytes to the parser or index", async () => {
    const bytes = new TextEncoder().encode("malicious test payload");
    const intake = {
      knowledge_file_intake_id: "33333333-3333-4333-8333-333333333333", knowledge_source_id: sourceId,
      knowledge_revision_id: null, idempotency_key: "upload-policy-1", status: "queued", object_key: "private/object",
      original_filename: "policy.txt", media_type: "text/plain", declared_bytes: bytes.byteLength,
      declared_sha256_base64: createHash("sha256").update(bytes).digest("base64"), attempt_count: 0, created_by_identity: "actor-1",
    };
    const query = jest.fn(async (sql: string) => sql.includes("SELECT *")
      ? { rows: [intake], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const client = { query } as unknown as PoolClient;
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)) };
    const storage = { readBounded: jest.fn(async () => bytes), delete: jest.fn(async () => undefined) };
    const scanner = { scan: jest.fn(async () => ({ status: "infected", engine: "test-scanner", signature: "EICAR-Test" })) };
    const parser = { parse: jest.fn() };
    const audit = { record: jest.fn(async () => undefined) };
    const result = await new KnowledgeFileIntakeService(database as never, audit as never, storage as never, scanner as never, parser as never).runOnce(tenantId, 1);
    expect(result).toEqual({ claimed: 1, succeeded: 0, quarantined: 1, failed: 0 });
    expect(parser.parse).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith("private/object");
  });
});
