import "dotenv/config.js";
import nodeCron from "node-cron";

import {
  genArticleJson,
  genImageBytes,
  genVideoBytesFromPromptAndImage,
} from "../src/services/gemini.js"; // uses Gemini text/image/video helpers
import { ttsToBuffer } from "../src/services/polly.js"; // AWS Polly TTS
import { putToS3 } from "../src/services/s3.js"; // AWS S3 uploader

import {
  insertArticle,
  updateArticleBySlugForAuthor,
} from "../src/models/article.model.js";
import { setArticleTags } from "../src/models/tag.model.js";
import { insertAsset } from "../src/models/asset.model.js";
import pool from "../src/config/db.js";

/* ------------ helpers ------------ */
function nowIso() {
  return new Date().toISOString();
}

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

// Where are we writing? (useful to detect env/db mismatches)
async function logWhereIAm() {
  try {
    const { rows } = await pool.query(
      "select current_database() as db, inet_server_addr()::text as host, inet_server_port() as port"
    );
    const r = rows?.[0] || {};
    console.log(
      `[${nowIso()}] [DB] db=${r.db} host=${r.host} port=${r.port}`
    );
  } catch (e) {
    console.warn(
      `[${nowIso()}] [DB] Could not introspect connection:`,
      e?.message || e
    );
  }
  console.log(
    `[${nowIso()}] [ENV] S3 bucket=${process.env.S3_BUCKET} region=${process.env.S3_REGION} keyId=...${(process.env.S3_ACCESS_KEY_ID || "").slice(-4)}`
  );
  console.log(
    `[${nowIso()}] [ENV] MODELS text=${process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash"} image=${process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002"} video=${process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-preview"}`
  );
}

async function withSingletonLock(lockId, fn) {
  const { rows } = await pool.query("SELECT pg_try_advisory_lock($1) AS ok", [
    lockId,
  ]);
  if (!rows?.[0]?.ok) {
    console.log(
      `[${nowIso()}] Another weeklyGenerator run is active. Skipping.`
    );
    return;
  }
  console.log(`[${nowIso()}] Acquired advisory lock (${lockId}).`);
  try {
    await fn();
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [lockId]);
    console.log(`[${nowIso()}] Released advisory lock (${lockId}).`);
  }
}

/* -------------------- generation -------------------- */
const SYSTEM_AUTHOR_ID = process.env.SYSTEM_AUTHOR_ID; // required

async function generateOne(topic, status = "draft") {
  const t0 = Date.now();
  console.log(`\n[${nowIso()}] === Begin generation for topic: "${topic}" ===`);

  await logWhereIAm();

  // 1) Article JSON (Gemini text)
  console.log(`[${nowIso()}] [STEP] Generating article JSON...`);
  const art = await genArticleJson(topic);
  if (!art.title || !art.description || !art.body) {
    throw new Error("generator returned empty fields (title/description/body)");
  }
  console.log(
    `[${nowIso()}] [OK] Article JSON → title="${art.title}" (${art.body.length} chars)`
  );

  const slug = slugify(art.title);

  // 2) Insert draft (DB)
  console.log(`[${nowIso()}] [STEP] Inserting article row...`);
  const articleId = await insertArticle({
    authorId: SYSTEM_AUTHOR_ID,
    slug,
    title: art.title,
    description: art.description,
    body: art.body,
    status, // "draft" or "published"
  });
  // Verify insert landed
  const { rows: verifyRows } = await pool.query(
    "select id, slug, createdAt from articles where id=$1 limit 1",
    [articleId]
  );
  if (!verifyRows?.length) {
    throw new Error(
      `Insert reported id=${articleId} but row not found (env mismatch?)`
    );
  }
  console.log(
    `[${nowIso()}] [OK] Inserted article id=${articleId} slug=${slug}`
  );

  // 3) Tags — always include "content-ai"
  console.log(`[${nowIso()}] [STEP] Setting tags...`);
  const rawTags = Array.isArray(art.tagList) ? art.tagList : [];
  const normalized = rawTags.map(normalizeTag).filter(Boolean);
  const tagList = Array.from(new Set([...normalized, "content-ai"])).slice(
    0,
    6
  );
  await setArticleTags(articleId, tagList);
  console.log(`[${nowIso()}] [OK] Tags set: [${tagList.join(", ")}]`);

  // 4) Hero image (Gemini/Imagen → S3 → asset)
  console.log(`[${nowIso()}] [STEP] Generating hero image...`);
  const imagePrompt = `High-quality, cinematic hero image for an AI/dev article titled "${art.title}".
Focus on abstract shapes, circuits, neural patterns, colorful gradients.
Avoid any logos, brand marks, text overlays, or watermarks.`;
  const imgStart = Date.now();
  const { bytes: imgBytes, mime: imgMime } = await genImageBytes(imagePrompt);
  const imgKey = `articles/${slug}/hero.png`;
  const imageUrl = await putToS3({
    key: imgKey,
    body: imgBytes,
    contentType: imgMime,
  });
  console.log(
    `[${nowIso()}] [OK] Image uploaded to S3 key=${imgKey} -> ${imageUrl} (${Date.now() - imgStart}ms)`
  );
  await insertAsset({
    articleId,
    type: "image",
    url: imageUrl,
    s3Key: imgKey,
    mimeType: imgMime,
  });
  console.log(
    `[${nowIso()}] [OK] Image asset inserted for article ${articleId}`
  );

  // Prepare holders for optional assets
  let voiceUrl = null;
  let videoUrl = null;

  // 5) Voiceover (Polly → S3 → asset)
  try {
    console.log(`[${nowIso()}] [STEP] Generating voiceover (Polly)...`);
    const ttsStart = Date.now();
    const teaser = `${art.title}. ${art.description}`;
    const voiceBuf = await ttsToBuffer(teaser.slice(0, 400));
    const voiceKey = `articles/${slug}/teaser.mp3`;
    voiceUrl = await putToS3({
      key: voiceKey,
      body: voiceBuf,
      contentType: "audio/mpeg",
    });
    console.log(
      `[${nowIso()}] [OK] Voice uploaded key=${voiceKey} -> ${voiceUrl} (${Date.now() - ttsStart}ms)`
    );
    await insertAsset({
      articleId,
      type: "audio",
      url: voiceUrl,
      s3Key: voiceKey,
      mimeType: "audio/mpeg",
    });
    console.log(
      `[${nowIso()}] [OK] Audio asset inserted for article ${articleId}`
    );
  } catch (err) {
    console.warn(
      `[${nowIso()}] [WARN] Polly TTS failed; continuing without audio:`,
      err?.message || err
    );
  }

  // 6) Video (Gemini/Veo → S3 → asset)
  if (process.env.DISABLE_VIDEO === "true") {
    console.log(`[${nowIso()}] [INFO] Video generation disabled by env.`);
  } else {
    console.log(`[${nowIso()}] [STEP] Generating teaser video (Veo)...`);
    const videoPrompt = `Tasteful, smooth parallax/zoom over abstract AI visuals inspired by "${art.title}".
No text, no logos, no brand marks, no UI screenshots.`;
    try {
      const vStart = Date.now();
      const {
        bytes: vidBytes,
        mime: vidMime,
        durationSec,
      } = await genVideoBytesFromPromptAndImage(videoPrompt, imgBytes);
      const videoKey = `articles/${slug}/teaser.mp4`;
      videoUrl = await putToS3({
        key: videoKey,
        body: vidBytes,
        contentType: vidMime,
      });
      console.log(
        `[${nowIso()}] [OK] Video uploaded key=${videoKey} -> ${videoUrl} (${Date.now() - vStart}ms)`
      );
      await insertAsset({
        articleId,
        type: "video",
        url: videoUrl,
        s3Key: videoKey,
        mimeType: vidMime,
        durationSec,
      });
      console.log(
        `[${nowIso()}] [OK] Video asset inserted for article ${articleId}`
      );
    } catch (err) {
      console.warn(
        `[${nowIso()}] [WARN] Video generation skipped:`,
        err?.message || err
      );
    }
  }

  // Optional auto-publish switch
  if (process.env.AUTO_PUBLISH_AI === "true" && status !== "published") {
    await updateArticleBySlugForAuthor({
      slug,
      authorId: SYSTEM_AUTHOR_ID,
      status: "published",
    });
    console.log(`[${nowIso()}] [OK] Auto-published slug=${slug}`);
  }

  console.log(
    `[${nowIso()}] === Finished "${topic}" in ${Date.now() - t0}ms — slug=${slug} ===`
  );

  return { slug, articleId, imageUrl, voiceUrl, videoUrl };
}

async function runBatch(count = 1, status = "draft") {
  if (!SYSTEM_AUTHOR_ID)
    throw new Error("SYSTEM_AUTHOR_ID env var is required");

  const topics = [
    "Practical RAG for small teams",
    "Prompt engineering patterns in 2025",
    "Vector databases vs keyword search",
    "Fine-tuning vs prompt-caching trade-offs",
    "AI safety basics for indie devs",
    "Edge AI: running models in the browser",
    "LLM evals: how to measure quality",
    "Multimodal UX patterns",
    "Agents that actually ship value",
    "LLM cost optimization tips",
  ];

  console.log(
    `[${nowIso()}] Starting batch: count=${count} status=${status}`
  );

  for (const t of topics.slice(0, count)) {
    try {
      const out = await generateOne(t, status);
      console.log(
        `[${nowIso()}] Generated: ${out.slug} | assets: image=${!!out.imageUrl} voice=${!!out.voiceUrl} video=${!!out.videoUrl}`
      );

      // Final DB sanity: fetch by slug we just created
      const { rows } = await pool.query(
        "select id, slug, status, createdAt from articles where slug=$1 limit 1",
        [out.slug]
      );
      console.log(
        `[${nowIso()}] [DB] Verified by slug:`,
        rows?.[0] || "(not found)"
      );
    } catch (e) {
      console.error(
        `[${nowIso()}] Failed generating topic: ${t} ::`,
        e?.message || e
      );
    }
  }
}

// CLI: --once  --count=1  --status=published
const argv = process.argv.slice(2);
const ONCE = argv.includes("--once") || process.env.RUN_ONCE === "true";
const COUNT =
  Number((argv.find((a) => a.startsWith("--count=")) || "").split("=")[1]) ||
  Number(process.env.GEN_COUNT || 1);
const STATUS =
  (argv.find((a) => a.startsWith("--status=")) || "").split("=")[1] ||
  process.env.GEN_STATUS ||
  "draft";

// lock id can be any int64; keep constant
const LOCK_ID = 42424242;

if (ONCE) {
  await withSingletonLock(LOCK_ID, async () => {
    await runBatch(COUNT, STATUS);
    // Show the last few rows to prove persistence in the DB we used
    try {
      const { rows } = await pool.query(
        "select slug, status, createdAt from articles order by createdAt desc limit 3"
      );
      console.log(`[${nowIso()}] [DB] Tail of articles:`, rows);
    } catch (e) {
      console.warn(
        `[${nowIso()}] [DB] Could not list tail of articles:`,
        e?.message || e
      );
    }
  });
  await pool.end();
  console.log(`[${nowIso()}] Pool ended. Exiting.`);
  process.exit(0);
} else {
  // every Sunday 03:00 UTC
  nodeCron.schedule("0 3 * * 0", async () => {
    await withSingletonLock(LOCK_ID, async () => {
      await runBatch(COUNT, STATUS);
    });
  });
  console.log(
    `[${nowIso()}] Weekly AI article cron scheduled (Sun 03:00 UTC).`
  );
}
