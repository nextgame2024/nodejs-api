import "dotenv/config.js";
import pool from "../src/config/db.js";
import {
  s3,
  getObjectBuffer,
  deleteFromS3,
  putToS3,
} from "../src/services/s3.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  getJobById,
  markProcessing,
  markDone,
  markFailed,
  softDeleteJob,
  getArticlePromptById,
} from "../src/models/render.model.js";
import {
  genImageBytes,
  genVideoBytesFromPrompt, // NEW: template-only video (no identity)
  genVideoBytesFromPromptAndImage, // identity-conditioned (user face)
  genNarrationFromPrompt,
} from "../src/services/gemini.js";
import { ttsToBuffer } from "../src/services/polly.js";
import { setArticleTags } from "../src/models/tag.model.js";
import { insertAsset } from "../src/models/asset.model.js";
import { getLatestVideoForArticle } from "../src/models/asset.model.js";
import { swapFaceOnVideo } from "../src/services/faceSwap.js";

const bucket = process.env.S3_BUCKET;

/* =========================
   CONFIG (env-overridable)
   ========================= */
const BRISBANE_TZ = "Australia/Brisbane";
const LOCK_ID = Number(process.env.CRON_LOCK_ID || 43434343);
const SWEEP_BATCH = Number(process.env.RENDER_SWEEP_BATCH || 2); // how many paid jobs per minute
const EXPIRE_HOURS = Number(process.env.RENDER_EXPIRES_HOURS || 24);
const DAILY_ARTICLES_HOUR = Number(process.env.CRON_ARTICLES_HOUR || 9); // 09:00 AEST
const CLEANUP_HOUR = Number(process.env.CRON_CLEANUP_HOUR || 3); // run cleanup at 03:00 AEST

const SYSTEM_AUTHOR_ID = process.env.SYSTEM_AUTHOR_ID; // required for article creation

/* ============ utils ============ */
function nowIso() {
  return new Date().toISOString();
}
function localNow() {
  return new Date(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: BRISBANE_TZ,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date())
  );
}
function isMinute(d, m) {
  return d.getMinutes() === m;
}
function isHour(d, h) {
  return d.getHours() === h;
}

async function withLock(fn) {
  const { rows } = await pool.query("SELECT pg_try_advisory_lock($1) AS ok", [
    LOCK_ID,
  ]);
  if (!rows?.[0]?.ok) {
    console.log(`[${nowIso()}] Lock busy; exit.`);
    return;
  }
  console.log(`[${nowIso()}] Acquired lock(${LOCK_ID}).`);
  try {
    await fn();
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    console.log(`[${nowIso()}] Released lock(${LOCK_ID}).`);
  }
}

/* ============ article creation from video_prompts (same logic) ============ */

function slugify(title = "") {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${base || "article"}-${rnd}`;
}
function normalizeTag(name = "") {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
function first150WithEllipsis(text = "") {
  const s = String(text || "");
  const short = s.slice(0, 1000);
  return short + (s.length > 1000 ? "..." : "...");
}

async function fetchNextVideoPrompt(client) {
  const { rows } = await client.query(
    `SELECT id, title, description, prompt, tag
       FROM video_prompts
      WHERE used = FALSE
      ORDER BY createdAt ASC, id ASC
      LIMIT 1`
  );
  return rows?.[0] || null;
}

async function insertArticleWithPrompt(
  client,
  { slug, title, description, body, prompt, status }
) {
  const { rows } = await client.query(
    `INSERT INTO articles (slug, title, description, body, author_id, status, prompt)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [slug, title, description, body, SYSTEM_AUTHOR_ID, status, prompt]
  );
  return rows?.[0]?.id;
}

async function markVideoPromptUsed(client, id) {
  await client.query(
    `UPDATE video_prompts SET used = TRUE, updatedAt = NOW() WHERE id = $1`,
    [id]
  );
}

async function generateFromVideoPromptOnce(status = "published") {
  if (!SYSTEM_AUTHOR_ID)
    throw new Error("SYSTEM_AUTHOR_ID env var is required");

  const client = await pool.connect();
  try {
    const vp = await fetchNextVideoPrompt(client);
    if (!vp) {
      console.log(`[${nowIso()}] No unused video_prompts. Skipping article.`);
      return null;
    }

    const slug = slugify(vp.title);
    const articleTitle = vp.title;
    const articleDesc = first150WithEllipsis(vp.description || "");
    const articleBody = vp.description || "";
    const articlePrompt = vp.prompt || "";

    console.log(
      `[${nowIso()}] [STEP] Insert article for prompt id=${vp.id}...`
    );
    const articleId = await insertArticleWithPrompt(client, {
      slug,
      title: articleTitle,
      description: articleDesc,
      body: articleBody,
      prompt: articlePrompt,
      status,
    });
    if (!articleId) throw new Error("Insert failed: no id");
    console.log(`[${nowIso()}] [OK] Article id=${articleId} slug=${slug}`);

    await markVideoPromptUsed(client, vp.id);
    const vpTag = vp.tag ? normalizeTag(vp.tag) : null;
    const tagList = [vpTag, "content-ai"].filter(Boolean);
    await setArticleTags(articleId, tagList.length ? tagList : ["content-ai"]);
    console.log(
      `[${nowIso()}] [OK] Tags: [${(tagList.length ? tagList : ["content-ai"]).join(", ")}]`
    );

    // Media: hero image, teaser video (template-only), narration
    try {
      const { bytes: imgBytes, mime: imgMime } =
        await genImageBytes(articlePrompt);
      const imgKey = `articles/${slug}/hero.png`;
      const imageUrl = await putToS3({
        key: imgKey,
        body: imgBytes,
        contentType: imgMime,
      });
      await insertAsset({
        articleId,
        type: "image",
        url: imageUrl,
        s3Key: imgKey,
        mimeType: imgMime,
      });
      console.log(`[${nowIso()}] [OK] Image asset inserted.`);

      if (process.env.DISABLE_VIDEO !== "true") {
        // IMPORTANT: template-only video (no identity reference here)
        const {
          bytes: vidBytes,
          mime: vidMime,
          durationSec,
        } = await genVideoBytesFromPrompt(articlePrompt);
        const videoKey = `articles/${slug}/teaser.mp4`;
        const videoUrl = await putToS3({
          key: videoKey,
          body: vidBytes,
          contentType: vidMime,
        });
        await insertAsset({
          articleId,
          type: "video",
          url: videoUrl,
          s3Key: videoKey,
          mimeType: vidMime,
          durationSec,
        });
        console.log(`[${nowIso()}] [OK] Video asset inserted.`);
      }

      try {
        const narration = await genNarrationFromPrompt(articlePrompt);
        const voiceBuf = await ttsToBuffer(narration || articleTitle);
        const voiceKey = `articles/${slug}/teaser.mp3`;
        const voiceUrl = await putToS3({
          key: voiceKey,
          body: voiceBuf,
          contentType: "audio/mpeg",
        });
        await insertAsset({
          articleId,
          type: "audio",
          url: voiceUrl,
          s3Key: voiceKey,
          mimeType: "audio/mpeg",
        });
        console.log(`[${nowIso()}] [OK] Audio asset inserted.`);
      } catch (err) {
        console.warn(
          `[${nowIso()}] [WARN] Audio generation skipped:`,
          err?.message || err
        );
      }
    } catch (err) {
      console.warn(
        `[${nowIso()}] [WARN] Media generation skipped:`,
        err?.message || err
      );
    }

    return { slug, articleId };
  } finally {
    client.release();
  }
}

/* ============ PAID RENDER SWEEP (every minute) ============ */

async function sweepPaid(max = SWEEP_BATCH) {
  const { rows } = await pool.query(
    `SELECT id FROM render_jobs
      WHERE status='paid' AND deleted_at IS NULL
      ORDER BY "updatedAt" ASC
      LIMIT $1`,
    [max]
  );
  for (const { id } of rows) {
    await processOnePaidJob(id);
  }
}

async function processOnePaidJob(jobId) {
  const job = await getJobById(jobId);
  if (!job) return;

  await markProcessing(jobId);

  try {
    // 1) Load the base (teaser) video that matches the article/effect the user selected
    if (!job.article_id) throw new Error("render_job missing article_id");

    const baseAsset = await getLatestVideoForArticle(job.article_id);
    if (!baseAsset?.s3_key) throw new Error("No base video asset for article");

    const baseVideoBytes = await getObjectBuffer(baseAsset.s3_key);

    // 2) Load the user's headshot (uploaded during checkout)
    if (!job.image_key) throw new Error("render_job missing image_key");
    const userImageBytes = await getObjectBuffer(job.image_key);

    // 3) Face-swap: put the user's face onto the base video
    const { bytes: swappedBytes, mime } = await swapFaceOnVideo({
      sourceImageBytes: userImageBytes,
      baseVideoBytes,
    });

    // 4) Upload to S3
    const outKey = `renders/${jobId}/output.mp4`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outKey,
        Body: swappedBytes,
        ContentType: mime || "video/mp4",
      })
    );

    // 5) Mark done (+expiry)
    const expiresAt = new Date(Date.now() + EXPIRE_HOURS * 3600_000);
    await markDone({ id: jobId, outputKey: outKey, thumbKey: null, expiresAt });

    console.log(`[${nowIso()}] [RENDER] Swapped ${jobId} -> ${outKey}`);
  } catch (e) {
    console.error(`[${nowIso()}] [RENDER] FAILED ${jobId}:`, e?.message || e);
    await markFailed(jobId, e?.message || String(e));
  }
}

// async function processOnePaidJob(jobId) {
//   const job = await getJobById(jobId);
//   if (!job) return;

//   await markProcessing(jobId);

//   try {
//     // 1) use the SAME article prompt used for the effect
//     const art = job.article_id
//       ? await getArticlePromptById(job.article_id)
//       : null;
//     const veoPrompt =
//       art?.prompt ||
//       art?.title ||
//       "Generate a short 9:16 cinematic clip using the uploaded face.";

//     // 2) read the user’s uploaded image from S3
//     const sourceBytes = await getObjectBuffer(job.image_key);

//     // 3) generate personalized video (identity-conditioned)
//     const { bytes: videoBytes, mime: videoMime } =
//       await genVideoBytesFromPromptAndImage(veoPrompt, sourceBytes);

//     // 4) store output (private object)
//     const outKey = `renders/${jobId}/output.mp4`;
//     await s3.send(
//       new PutObjectCommand({
//         Bucket: bucket,
//         Key: outKey,
//         Body: videoBytes,
//         ContentType: videoMime || "video/mp4",
//       })
//     );

//     // 5) set expiry (+24h by default)
//     const expiresAt = new Date(Date.now() + EXPIRE_HOURS * 3600_000);
//     await markDone({ id: jobId, outputKey: outKey, thumbKey: null, expiresAt });

//     console.log(
//       `[${nowIso()}] [RENDER] Done ${jobId} -> ${outKey}, expires ${expiresAt.toISOString()}`
//     );
//   } catch (e) {
//     console.error(`[${nowIso()}] [RENDER] FAILED ${jobId}:`, e?.message || e);
//     await markFailed(jobId, e?.message || String(e));
//   }
// }

/* ============ CLEANUP (daily — hard delete S3, soft-delete DB) ============ */

async function cleanupExpired(limit = 200) {
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
      if (r.output_video_key) await deleteFromS3(r.output_video_key);
      if (r.image_key) await deleteFromS3(r.image_key);
      await softDeleteJob(r.id, "expired cleanup (>24h)");
      console.log(`[${nowIso()}] [CLEANUP] Purged S3 + soft-deleted ${r.id}`);
    } catch (e) {
      console.error(`[${nowIso()}] [CLEANUP] Error ${r.id}:`, e?.message || e);
    }
  }
}

/* ============ ENTRY: run every minute ============ */

(async function main() {
  await withLock(async () => {
    const dLocal = localNow();

    // 1) every minute — process a small batch of paid jobs
    await sweepPaid(SWEEP_BATCH);

    // 2) once per day — cleanup expired outputs and soft-delete rows
    if (isHour(dLocal, CLEANUP_HOUR) && isMinute(dLocal, 0)) {
      await cleanupExpired(200);
    }

    // 3) once per day — create article(s) from video_prompts
    if (isHour(dLocal, DAILY_ARTICLES_HOUR) && isMinute(dLocal, 0)) {
      try {
        await generateFromVideoPromptOnce("published"); // 1 article/day (adjust if you want more)
      } catch (e) {
        console.error(`[${nowIso()}] [ARTICLES] Failed:`, e?.message || e);
      }
    }
  });

  // exit quickly; Render Cron will re-run next minute
  process.exit(0);
})();
