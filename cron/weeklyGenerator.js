import "dotenv/config.js";
import nodeCron from "node-cron";

import {
  genArticleJson,
  genImageBytes,
  genVideoBytesFromPromptAndImage,
} from "../src/services/gemini.js";
import { ttsToBuffer } from "../src/services/polly.js";
import { putToS3 } from "../src/services/s3.js";

import {
  insertArticle,
  updateArticleBySlugForAuthor,
} from "../src/models/article.model.js";
import { setArticleTags } from "../src/models/tag.model.js";
import { insertAsset } from "../src/models/asset.model.js";
import pool from "../src/config/db.js";

/* ------------ helpers ------------ */
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

// Advisory lock so only one run executes at a time (Postgres/Neon).
async function withSingletonLock(lockId, fn) {
  const { rows } = await pool.query("SELECT pg_try_advisory_lock($1) AS ok", [
    lockId,
  ]);
  if (!rows?.[0]?.ok) {
    console.log("Another weeklyGenerator run is active. Skipping.");
    return;
  }
  try {
    await fn();
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [lockId]);
  }
}

/* -------------------- generation -------------------- */
const SYSTEM_AUTHOR_ID = process.env.SYSTEM_AUTHOR_ID; // required

async function generateOne(topic, status = "draft") {
  // 1) Article JSON
  const art = await genArticleJson(topic);
  if (!art.title || !art.description || !art.body) {
    throw new Error("generator returned empty fields (title/description/body)");
  }
  const slug = slugify(art.title);

  // 2) Insert draft
  const articleId = await insertArticle({
    authorId: SYSTEM_AUTHOR_ID,
    slug,
    title: art.title,
    description: art.description,
    body: art.body,
    status, // "draft" or "published"
  });

  // 3) Tags — always include "content-ai"
  const rawTags = Array.isArray(art.tagList) ? art.tagList : [];
  const normalized = rawTags.map(normalizeTag).filter(Boolean);
  const tagList = Array.from(new Set([...normalized, "content-ai"])).slice(
    0,
    6
  );
  await setArticleTags(articleId, tagList);

  // 4) Hero image (Gemini/Imagen)
  const imagePrompt = `High-quality, cinematic hero image for an AI/dev article titled "${art.title}".
    Focus on abstract shapes, circuits, neural patterns, colorful gradients.
    Avoid any logos, brand marks, text overlays, or watermarks.`;
  const { bytes: imgBytes, mime: imgMime } = await genImageBytes(imagePrompt);
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

  // 5) Voiceover (short teaser)
  try {
    const teaser = `${art.title}. ${art.description}`;
    const voiceBuf = await ttsToBuffer(teaser.slice(0, 400));
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
  } catch (err) {
    console.warn(
      "[weeklyGenerator] Polly TTS failed; continuing without audio:",
      err?.message || err
    );
  }

  // 6) Video (Gemini/Veo), seeded by the image
  const videoPrompt = `Tasteful, smooth parallax/zoom over abstract AI visuals inspired by "${art.title}".
    No text, no logos, no brand marks, no UI screenshots.`;
  const {
    bytes: vidBytes,
    mime: vidMime,
    durationSec,
  } = await genVideoBytesFromPromptAndImage(videoPrompt, imgBytes);
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

  // Optional auto-publish switch
  if (process.env.AUTO_PUBLISH_AI === "true" && status !== "published") {
    await updateArticleBySlugForAuthor({
      slug,
      authorId: SYSTEM_AUTHOR_ID,
      status: "published",
    });
  }

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

  for (const t of topics.slice(0, count)) {
    try {
      const out = await generateOne(t, status);
      console.log("Generated:", out.slug);
    } catch (e) {
      console.error("Failed generating topic:", t, e?.message || e);
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
  });
  await pool.end();
  process.exit(0);
} else {
  // every Sunday 03:00 UTC
  nodeCron.schedule("0 3 * * 0", async () => {
    await withSingletonLock(LOCK_ID, async () => {
      await runBatch(COUNT, STATUS);
    });
  });
  console.log("Weekly AI article cron scheduled (Sun 03:00 UTC).");
}
