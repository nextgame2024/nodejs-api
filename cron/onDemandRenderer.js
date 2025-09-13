import "dotenv/config.js";
import nodeCron from "node-cron";
import pool from "../src/config/db.js";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import {
  getArticlePromptById,
  markProcessing,
  markDone,
  markFailed,
  getJobById,
  markEmailSent,
} from "../src/models/render.model.js";
import { genVideoBytesFromPromptAndImage } from "../src/services/gemini.js";
import { sendRenderReadyEmail } from "../src/services/email.js";

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
const bucket = process.env.S3_BUCKET;
const log = (...a) => console.log(`[onDemandRenderer]`, ...a);

async function getSourceBuffer(key) {
  const resp = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  return Buffer.from(await resp.Body?.transformToByteArray());
}

async function putOutput(key, bytes, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
    })
  );
  return `s3://${bucket}/${key}`;
}

async function processOne(jobId) {
  const job = await getJobById(jobId);
  if (!job || job.status !== "paid") return;

  await markProcessing(jobId);

  try {
    const article = job.article_id
      ? await getArticlePromptById(job.article_id)
      : null;
    const veoPrompt =
      article?.prompt ||
      article?.title ||
      "Generate a short cinematic clip with the actor from the image.";
    const source = await getSourceBuffer(job.image_key);

    // Generate video using user's image + article prompt
    const { bytes: videoBytes, mime: videoMime } =
      await genVideoBytesFromPromptAndImage(veoPrompt, source);

    const outKey = `renders/${jobId}/output.mp4`;
    await putOutput(outKey, videoBytes, videoMime || "video/mp4");

    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000); // +24h
    await markDone({ id: jobId, outputKey: outKey, thumbKey: null, expiresAt });

    // Email (if we have a destination)
    const to = job.guest_email || null; // (or look up user email by job.user_id)
    if (to) {
      const successUrl = `${process.env.CLIENT_URL}/checkout/success?jobId=${jobId}`;
      await sendRenderReadyEmail({
        to,
        jobId,
        effectName: article?.title || "Your sophiaAi video",
        successUrl,
        expiresAt,
      });
      await markEmailSent(jobId);
    }

    log(`Rendered & stored ${jobId} -> ${outKey}`);
  } catch (err) {
    await markFailed(jobId, err?.message || String(err));
    log(`FAILED ${jobId}:`, err?.message || err);
  }
}

async function sweepPaid(limit = 3) {
  const { rows } = await pool.query(
    `SELECT id FROM render_jobs
        WHERE status = 'paid' AND deleted_at IS NULL
        ORDER BY "updatedAt" ASC
        LIMIT $1`,
    [Math.max(1, limit)]
  );
  for (const r of rows) await processOne(r.id);
}

async function deleteIfExists(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    // swallow 404s; log other errors
    if (e?.$metadata?.httpStatusCode !== 404) {
      log(`DeleteObject error for ${key}:`, e?.message || e);
    }
  }
}

async function cleanupExpired(limit = 25) {
  const { rows } = await pool.query(
    `SELECT id, image_key, output_video_key
         FROM render_jobs
        WHERE deleted_at IS NULL
          AND expires_at IS NOT NULL
          AND expires_at < NOW()
        ORDER BY expires_at ASC
        LIMIT $1`,
    [limit]
  );

  for (const r of rows) {
    try {
      await deleteIfExists(r.output_video_key); // the rendered video
      await deleteIfExists(r.image_key); // the source image (optional but recommended)
      await softDeleteJob(r.id, "expired cleanup: > 24h");
      log(`Soft-deleted job ${r.id} and purged S3 objects`);
    } catch (e) {
      log(`Cleanup error for ${r.id}:`, e?.message || e);
    }
  }
}

// Run every minute; cleanup every 15 minutes
nodeCron.schedule("* * * * *", async () => {
  await sweepPaid(3);
});
nodeCron.schedule("*/15 * * * *", async () => {
  await cleanupExpired(25);
});

log("onDemandRenderer cron scheduled.");
