import { Injectable } from "@nestjs/common";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { runtimeConfig } from "../../../config/runtime-config.js";
import type { KnowledgeObjectStorage } from "./knowledge-file.ports.js";

@Injectable()
export class PrivateS3KnowledgeStorageService implements KnowledgeObjectStorage {
  private readonly config = runtimeConfig().knowledgeFiles;
  private readonly client = this.config.region ? new S3Client({
    region: this.config.region,
    ...(this.config.endpoint ? { endpoint: this.config.endpoint, forcePathStyle: true } : {}),
  }) : undefined;

  async readiness(): Promise<{ ready: boolean; reason?: string }> {
    if (!this.client || !this.config.bucket || !this.config.region) {
      return { ready: false, reason: "private_storage_not_configured" };
    }
    try {
      const result = await this.client.send(new GetPublicAccessBlockCommand({ Bucket: this.config.bucket }));
      const block = result.PublicAccessBlockConfiguration;
      if (!block?.BlockPublicAcls || !block.IgnorePublicAcls || !block.BlockPublicPolicy || !block.RestrictPublicBuckets) {
        return { ready: false, reason: "bucket_public_access_block_incomplete" };
      }
      return { ready: true };
    } catch {
      return { ready: false, reason: "private_storage_unreachable_or_unverified" };
    }
  }

  async createUpload(input: {
    objectKey: string;
    mediaType: "text/plain" | "text/markdown";
    contentLength: number;
    checksumSha256Base64: string;
  }) {
    const client = this.requiredClient();
    const command = new PutObjectCommand({
      Bucket: this.config.bucket!,
      Key: input.objectKey,
      ContentType: input.mediaType,
      ContentLength: input.contentLength,
      ChecksumSHA256: input.checksumSha256Base64,
      ServerSideEncryption: "AES256",
      Metadata: { "sophia-quarantine": "true" },
    });
    return {
      uploadUrl: await getSignedUrl(client, command, { expiresIn: this.config.uploadTtlSeconds }),
      expiresIn: this.config.uploadTtlSeconds,
      requiredHeaders: {
        "content-type": input.mediaType,
        "x-amz-checksum-sha256": input.checksumSha256Base64,
        "x-amz-server-side-encryption": "AES256",
        "x-amz-meta-sophia-quarantine": "true",
      },
    };
  }

  async inspect(objectKey: string) {
    const result = await this.requiredClient().send(new HeadObjectCommand({ Bucket: this.config.bucket!, Key: objectKey, ChecksumMode: "ENABLED" }));
    return {
      contentLength: Number(result.ContentLength ?? -1),
      mediaType: result.ContentType,
      checksumSha256Base64: result.ChecksumSHA256,
    };
  }

  async readBounded(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    const result = await this.requiredClient().send(new GetObjectCommand({
      Bucket: this.config.bucket!, Key: objectKey, Range: `bytes=0-${maxBytes}`,
    }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error("knowledge_object_size_invalid");
    return bytes;
  }

  async delete(objectKey: string): Promise<void> {
    await this.requiredClient().send(new DeleteObjectCommand({ Bucket: this.config.bucket!, Key: objectKey }));
  }

  private requiredClient(): S3Client {
    if (!this.client || !this.config.bucket) throw new Error("private_storage_not_configured");
    return this.client;
  }
}
