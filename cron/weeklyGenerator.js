import "dotenv/config.js";
import nodeCron from "node-cron";

import {
  genImageBytes,
  genVideoBytesFromPromptAndImage,
  genNarrationFromPrompt,
} from "../src/services/gemini.js"; // Gemini helpers
import { ttsToBuffer } from "../src/services/polly.js"; // AWS Polly TTS
import { putToS3 } from "../src/services/s3.js"; // AWS S3 uploader

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

// Where are we writing? (useful to detect env/db mismatches)
async function logWhereIAm() {
  try {
    const { rows } = await pool.query(
      "select current_database() as db, inet_server_addr()::text as host, inet_server_port() as port"
    );
    const r = rows?.[0] || {};
    console.log(`[${nowIso()}] [DB] db=${r.db} host=${r.host} port=${r.port}`);
  } catch (e) {
    console.warn(
      `[${nowIso()}] [DB] Could not introspect connection:`,
      e?.message || e
    );
  }
  console.log(
    `[${nowIso()}] [ENV] S3 bucket=${process.env.S3_BUCKET} region=${process.env.S3_REGION} keyId=...${(
      process.env.S3_ACCESS_KEY_ID || ""
    ).slice(-4)}`
  );
  console.log(
    `[${nowIso()}] [ENV] MODELS image=${process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002"} video=${
      process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-preview"
    }`
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

/* -------------------- generation from video_prompts -------------------- */
const SYSTEM_AUTHOR_ID = process.env.SYSTEM_AUTHOR_ID; // required

async function fetchNextVideoPrompt(client) {
  // Keep it simple since we run under a global advisory lock already.
  const { rows } = await client.query(
    `SELECT id, title, description, prompt
     FROM video_prompts
     WHERE used = FALSE
     ORDER BY createdAt ASC, id ASC
     LIMIT 1`
  );
  return rows?.[0] || null;
}

function first150WithEllipsis(text = "") {
  const s = String(text || "");
  const short = s.slice(0, 800);
  return short + (s.length > 800 ? "..." : "...");
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

async function generateFromVideoPrompt(status = "published") {
  if (!SYSTEM_AUTHOR_ID)
    throw new Error("SYSTEM_AUTHOR_ID env var is required");

  console.log(`\n[${nowIso()}] === Begin generation from video_prompts ===`);
  await logWhereIAm();

  const client = await pool.connect();
  try {
    const vp = await fetchNextVideoPrompt(client);
    if (!vp) {
      console.log(
        `[${nowIso()}] No unused video_prompts available. Nothing to do.`
      );
      return null;
    }

    const slug = slugify(vp.title);
    const articleTitle = vp.title;
    const articleDescription = first150WithEllipsis(vp.description || "");
    const articleBody = vp.description || "";
    const articlePrompt = vp.prompt || "";

    // Insert article row (with prompt)
    console.log(
      `[${nowIso()}] [STEP] Inserting article for prompt id=${vp.id}...`
    );
    const articleId = await insertArticleWithPrompt(client, {
      slug,
      title: articleTitle,
      description: articleDescription,
      body: articleBody,
      prompt: articlePrompt,
      status, // publish immediately as requested
    });

    if (!articleId) {
      throw new Error("Insert failed: no id returned");
    }
    console.log(
      `[${nowIso()}] [OK] Inserted article id=${articleId} slug=${slug}`
    );

    // Mark used immediately once article row exists
    await markVideoPromptUsed(client, vp.id);
    console.log(
      `[${nowIso()}] [OK] Marked video_prompts.id=${vp.id} as used=true`
    );

    // Tags — fixed series tag for analytics
    const tagList = [vp.tag, "content-ai"];
    await setArticleTags(articleId, tagList);
    console.log(`[${nowIso()}] [OK] Tags set: [${tagList.join(", ")}]`);

    // Generate media FROM the Veo prompt
    // 1) IMAGE: feed the same prompt to Imagen (hero image)
    console.log(
      `[${nowIso()}] [STEP] Generating hero image from Veo prompt...`
    );
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
    console.log(`[${nowIso()}] [OK] Image asset inserted (${imageUrl})`);

    // 2) VIDEO: Veo from Veo prompt + the hero image as conditioning
    if (process.env.DISABLE_VIDEO === "true") {
      console.log(`[${nowIso()}] [INFO] Video generation disabled by env.`);
    } else {
      console.log(
        `[${nowIso()}] [STEP] Generating teaser video from Veo prompt...`
      );
      try {
        const {
          bytes: vidBytes,
          mime: vidMime,
          durationSec,
        } = await genVideoBytesFromPromptAndImage(articlePrompt, imgBytes);
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
        console.log(`[${nowIso()}] [OK] Video asset inserted (${videoUrl})`);
      } catch (err) {
        console.warn(
          `[${nowIso()}] [WARN] Video generation skipped:`,
          err?.message || err
        );
      }
    }

    // 3) AUDIO: Ask Gemini for a short narration script from the prompt, then synthesize with Polly
    try {
      console.log(
        `[${nowIso()}] [STEP] Generating narration from Veo prompt...`
      );
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
      console.log(`[${nowIso()}] [OK] Audio asset inserted (${voiceUrl})`);
    } catch (err) {
      console.warn(
        `[${nowIso()}] [WARN] Audio generation skipped:`,
        err?.message || err
      );
    }

    // Final DB sanity: fetch by slug we just created
    const { rows } = await client.query(
      `SELECT id, title, description, prompt, tag
       FROM video_prompts
       WHERE used = FALSE
       ORDER BY createdAt ASC, id ASC
       LIMIT 1`
    );
    console.log(
      `[${nowIso()}] [DB] Verified by slug:`,
      rows?.[0] || "(not found)"
    );

    return { slug, articleId };
  } finally {
    client.release();
  }
}

async function runBatch(count = 1, status = "published") {
  console.log(
    `[${nowIso()}] Starting batch from video_prompts: count=${count} status=${status}`
  );
  for (let i = 0; i < count; i++) {
    try {
      const out = await generateFromVideoPrompt(status);
      if (!out) break; // no more prompts
      console.log(`[${nowIso()}] Generated: ${out.slug}`);
    } catch (e) {
      console.error(
        `[${nowIso()}] Failed generating from video_prompts:`,
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
  "published";

// lock id can be any int64; keep constant
const LOCK_ID = 43434343;

if (ONCE) {
  await withSingletonLock(LOCK_ID, async () => {
    await runBatch(COUNT, STATUS);
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
    `[${nowIso()}] Weekly video_prompts cron scheduled (Sun 03:00 UTC).`
  );
}
