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
} from "../src/models/render.model.js";
import { setArticleTags } from "../src/models/tag.model.js";
import {
  insertAsset,
  getLatestVideoForArticle,
} from "../src/models/asset.model.js";
import {
  genImageBytes,
  genVideoBytesFromPrompt,
  genNarrationFromPrompt,
} from "../src/services/gemini.js";
import { ttsToBuffer } from "../src/services/polly.js";
import swapFaceOnVideo from "../src/services/faceSwap.pod.js";

const bucket = process.env.S3_BUCKET;

/* =========================
   CONFIG (env-overridable)
   ========================= */
const BRISBANE_TZ = "Australia/Brisbane";
const LOCK_ID = Number(process.env.CRON_LOCK_ID || 43434343);
const SWEEP_BATCH = Number(process.env.RENDER_SWEEP_BATCH || 2); // paid jobs per minute
const EXPIRE_HOURS = Number(process.env.RENDER_EXPIRES_HOURS || 24);

// defaults you requested: 1am articles, 3am cleanup
const DAILY_ARTICLES_HOUR = Number(process.env.CRON_ARTICLES_HOUR || 1);
const CLEANUP_HOUR = Number(process.env.CRON_CLEANUP_HOUR || 3);

// worker loop cadence (ms)
const LOOP_MS = Number(process.env.WORKER_LOOP_MS || 60_000);

const SYSTEM_AUTHOR_ID = process.env.SYSTEM_AUTHOR_ID; // required for article creation

/* ============ utils ============ */
function nowIso() {
  return new Date().toISOString();
}

/** Safe Brisbane “clock” without constructing a locale-parsed Date */
function localClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BRISBANE_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date())
    .reduce((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, /** @type {Record<string,string>} */ ({}));

  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    ymd, // "YYYY-MM-DD"
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

async function withLock(fn) {
  const { rows } = await pool.query("SELECT pg_try_advisory_lock($1) AS ok", [
    LOCK_ID,
  ]);
  if (!rows?.[0]?.ok) {
    console.log(`[${nowIso()}] Lock busy; skipping cycle.`);
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
function firstExcerpt(text = "", n = 150) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, n) + (s.length > n ? "..." : "");
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
    const articleDesc = firstExcerpt(vp.description || "", 150);
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

    // Media: hero image, template-only teaser video, narration (best-effort)
    try {
      // Image
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

      // Video (template-only)
      if (process.env.DISABLE_VIDEO !== "true") {
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

      // Audio narration
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
    // (A) base teaser video of the selected article
    if (!job.article_id) throw new Error("render_job missing article_id");
    const baseAsset = await getLatestVideoForArticle(job.article_id);
    if (!baseAsset?.s3_key) {
      throw new Error("No base video asset for article (missing s3_key)");
    }

    // fetch the base teaser video from S3
    const baseVideoBytes = await getObjectBuffer(baseAsset.s3_key);
    if (!Buffer.isBuffer(baseVideoBytes) || baseVideoBytes.length === 0) {
      throw new Error(
        `Base video missing/empty. s3_key=${baseAsset.s3_key} len=${baseVideoBytes?.length || 0}`
      );
    }

    // (B) the user's uploaded headshot
    if (!job.image_key) throw new Error("render_job missing image_key");

    const userImageBytes = await getObjectBuffer(job.image_key);
    if (!Buffer.isBuffer(userImageBytes) || userImageBytes.length === 0) {
      throw new Error(
        `User image missing/empty. image_key=${job.image_key} len=${userImageBytes?.length || 0}`
      );
    }

    console.log(
      `[${nowIso()}] [RENDER] swap start job=${jobId} faceKey=${job.image_key} baseKey=${baseAsset.s3_key} ` +
        `sizes face=${userImageBytes.length}B video=${baseVideoBytes.length}B`
    );

    // (C) face-swap — pass the names your wrapper expects
    const { bytes: swappedBytes, mime } = await swapFaceOnVideoViaPod({
      faceKey: job.image_key,
      videoKey: baseAsset.s3_key,
      // extraArgs: ["--face-color-corrections", "rct"] // if you add pass-through later
    });

    if (!Buffer.isBuffer(swappedBytes) || swappedBytes.length === 0) {
      throw new Error("Face-swap returned empty output buffer");
    }

    // (D) upload final
    const outKey = `renders/${jobId}/output.mp4`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outKey,
        Body: swappedBytes,
        ContentType: mime || "video/mp4",
      })
    );

    // (E) mark done (+expiry)
    const expiresAt = new Date(Date.now() + EXPIRE_HOURS * 3600_000);
    await markDone({ id: jobId, outputKey: outKey, thumbKey: null, expiresAt });

    console.log(
      `[${nowIso()}] [RENDER] swap done job=${jobId} -> s3://${bucket}/${outKey} (expires ${expiresAt.toISOString()})`
    );
  } catch (e) {
    console.error(`[${nowIso()}] [RENDER] FAILED ${jobId}:`, e?.message || e);
    await markFailed(jobId, e?.message || String(e));
  }
}

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

/* ============ ENTRY: worker loop ============ */

const RUN_ONCE =
  process.argv.includes("--once") || process.env.RUN_ONCE === "1";
let lastArticleRunDay = null; // "YYYY-MM-DD"
let lastCleanupRunDay = null; // "YYYY-MM-DD"

async function runCycle() {
  await withLock(async () => {
    const clk = localClock(); // { ymd, hour, minute, second }

    // 1) every minute — process a small batch of paid jobs
    await sweepPaid(SWEEP_BATCH);

    // 2) daily cleanup at CLEANUP_HOUR
    if (clk.hour === CLEANUP_HOUR && lastCleanupRunDay !== clk.ymd) {
      await cleanupExpired(200);
      lastCleanupRunDay = clk.ymd;
    }

    // 3) daily article creation at DAILY_ARTICLES_HOUR
    if (clk.hour === DAILY_ARTICLES_HOUR && lastArticleRunDay !== clk.ymd) {
      try {
        await generateFromVideoPromptOnce("published");
      } catch (e) {
        console.error(`[${nowIso()}] [ARTICLES] Failed:`, e?.message || e);
      }
      lastArticleRunDay = clk.ymd;
    }
  });
}

(async () => {
  if (RUN_ONCE) {
    console.log(`[${nowIso()}] Running single cycle (--once).`);
    await runCycle();
    process.exit(0);
  } else {
    console.log(
      `[${nowIso()}] Background worker loop started (every ${LOOP_MS}ms) — articles at ${DAILY_ARTICLES_HOUR}:00, cleanup at ${CLEANUP_HOUR}:00 (${BRISBANE_TZ}).`
    );
    for (;;) {
      await runCycle();
      await new Promise((r) => setTimeout(r, LOOP_MS));
    }
  }
})();
