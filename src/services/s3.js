// src/services/s3.js
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";

const region = process.env.S3_REGION;
const bucket = process.env.S3_BUCKET;

export const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

/** Legacy helper for public uploads used by article media.
 *  For render assets keep objects private (use signPutUrl + signGetUrl).
 */
export async function putToS3({ key, body, contentType }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  // Return a CDN-style URL only if your bucket policy serves it publicly.
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodeURI(key)}`;
}

/** Presigned PUT (browser upload of user’s source image) */
export async function signPutUrl(
  key,
  contentType = "application/octet-stream",
  ttl = 60
) {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  return presign(s3, cmd, { expiresIn: ttl });
}

/** Presigned GET (private delivery of rendered video). Default TTL: 6h */
export async function signGetUrl(key, expiresSec) {
  const ttl = Number(expiresSec || process.env.SIGNED_URL_TTL_SEC || 21600); // 6 hours
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return presign(s3, cmd, { expiresIn: ttl });
}

/** Read object into Buffer (used to pass the user’s image to Veo) */
export async function getObjectBuffer(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  return Buffer.from(bytes || []);
}

/** Hard-delete object from S3 (cleanup) */
export async function deleteFromS3(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    if (e?.$metadata?.httpStatusCode !== 404) throw e;
  }
}
