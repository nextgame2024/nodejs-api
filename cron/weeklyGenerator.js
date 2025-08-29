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

// Simple slugify same as controller
function slugify(title = "") {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${base || "article"}-${rnd}`;
}

// Choose a system user as author for AI posts (configure in .env)
const SYSTEM_AUTHOR_ID = process.env.SYSTEM_AUTHOR_ID;

async function generateOne(topic) {
  // 1) Article JSON
  const art = await genArticleJson(topic);
  const slug = slugify(art.title);

  // 2) Insert draft
  const articleId = await insertArticle({
    authorId: SYSTEM_AUTHOR_ID,
    slug,
    title: art.title,
    description: art.description,
    body: art.body,
    status: "draft",
  });

  // 3) Tags
  await setArticleTags(articleId, (art.tagList || []).slice(0, 6));

  // 4) Generate hero image with Imagen
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
    width: null,
    height: null,
  });

  // 5) VOICEOVER (short teaser) via Polly
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
    durationSec: null,
  });

  // 6) VIDEO via Veo 3 (8s, 16:9), seeded by image
  const videoPrompt = `A tasteful, smooth parallax/zoom over an abstract AI visuals inspired by the article "${art.title}".
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

  // (Optional) auto-publish after generation
  if (process.env.AUTO_PUBLISH_AI === "true") {
    await updateArticleBySlugForAuthor({
      slug,
      authorId: SYSTEM_AUTHOR_ID,
      status: "published",
    });
  }

  return { slug, articleId, imageUrl, voiceUrl, videoUrl };
}

// Run once now (so you can test locally) and also schedule weekly (Sunday 03:00 UTC)
async function runBatch(count = 10) {
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

  const picked = topics.slice(0, count);
  for (const t of picked) {
    try {
      const out = await generateOne(t);
      console.log("Generated:", out);
    } catch (e) {
      console.error("Failed generating topic:", t, e);
    }
  }
}

if (process.env.RUN_ONCE === "true") {
  runBatch().then(() => pool.end());
} else {
  // Schedule weekly
  nodeCron.schedule("0 3 * * 0", () => {
    runBatch().catch(console.error);
  });
  console.log("Weekly AI article cron scheduled (Sun 03:00 UTC).");
}
