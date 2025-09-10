import "dotenv/config.js";
import nodeCron from "node-cron";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

function normalizeTag(name = "") {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function runFFmpeg(args = [], logLabel = "ffmpeg") {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      const e = new Error(
        `[${logLabel}] exit ${code}: ${err.split("\n").slice(-6).join(" | ")}`
      );
      e.code = code;
      e.stderr = err;
      reject(e);
    });
  });
}

function haveFFmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return r.status === 0;
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
  const { rows } = await client.query(
    `SELECT id, title, description, prompt, tag
     FROM video_prompts
     WHERE used = FALSE
     ORDER BY createdAt ASC, id ASC
     LIMIT 1`
  );
  return rows?.[0] || null;
}

function first150WithEllipsis(text = "") {
  const s = String(text || "");
  const short = s.slice(0, 150);
  return short + (s.length > 150 ? "..." : "...");
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
      status, // publish immediately
    });

    if (!articleId) {
      throw new Error("Insert failed: no id returned");
    }
    console.log(
      `[${nowIso()}] [OK] Inserted article id=${articleId} slug=${slug}`
    );

    // Mark used
    await markVideoPromptUsed(client, vp.id);
    console.log(
      `[${nowIso()}] [OK] Marked video_prompts.id=${vp.id} as used=true`
    );

    // Tags — from video_prompts.tag plus 'content-ai'
    const vpTag = vp.tag ? normalizeTag(vp.tag) : null;
    const tagList = [vpTag, "content-ai"].filter(Boolean);
    if (tagList.length === 0) tagList.push("content-ai");
    await setArticleTags(articleId, tagList);
    console.log(`[${nowIso()}] [OK] Tags set: [${tagList.join(", ")}]`);

    // 1) IMAGE: hero image from Veo prompt
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

    // 2) VIDEO: two segments stitched (requires ffmpeg)
    if (process.env.DISABLE_VIDEO === "true") {
      console.log(`[${nowIso()}] [INFO] Video generation disabled by env.`);
    } else if (!haveFFmpeg()) {
      console.warn(
        `[${nowIso()}] [WARN] ffmpeg not found. Skipping video generation. Set DISABLE_VIDEO=true to silence this warning.`
      );
    } else {
      console.log(
        `[${nowIso()}] [STEP] Generating teaser video (two segments) from Veo prompt...`
      );
      try {
        // Segment A
        const segA = await genVideoBytesFromPromptAndImage(
          articlePrompt,
          imgBytes
        );

        // Segment B (continuation hint)
        const continuation =
          "\n\nCONTINUATION: continue seamlessly from the previous ending pose; begin at payoff and resolve. Maintain same framing, lighting, and timing.";
        const segB = await genVideoBytesFromPromptAndImage(
          articlePrompt + continuation,
          imgBytes
        );

        // Write temp files
        const tmpDir = process.env.TMPDIR || "/tmp";
        const aPath = path.join(tmpDir, `${slug}_a.mp4`);
        const bPath = path.join(tmpDir, `${slug}_b.mp4`);
        const listPath = path.join(tmpDir, `${slug}_inputs.txt`);
        const outPath = path.join(tmpDir, `${slug}_stitched.mp4`);

        await fs.writeFile(aPath, segA.bytes);
        await fs.writeFile(bPath, segB.bytes);
        await fs.writeFile(listPath, `file ${aPath}\nfile ${bPath}\n`);

        let stitchedBytes;
        try {
          // stream copy concat (no re-encode)
          await runFFmpeg(
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-f",
              "concat",
              "-safe",
              "0",
              "-i",
              listPath,
              "-c",
              "copy",
              outPath,
            ],
            "concat-copy"
          );
          stitchedBytes = await fs.readFile(outPath);
        } catch (copyErr) {
          console.warn(
            `[${nowIso()}] [WARN] concat-copy failed, falling back to re-encode: ${copyErr.message}`
          );
          // robust re-encode, 30 fps, yuv420p
          await runFFmpeg(
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-i",
              aPath,
              "-i",
              bPath,
              "-filter_complex",
              "[0:v:0][1:v:0]concat=n=2:v=1:a=0[outv]",
              "-map",
              "[outv]",
              "-r",
              "30",
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "18",
              "-pix_fmt",
              "yuv420p",
              "-movflags",
              "+faststart",
              outPath,
            ],
            "concat-reencode"
          );
          stitchedBytes = await fs.readFile(outPath);
        }

        const videoKey = `articles/${slug}/teaser.mp4`;
        const videoUrl = await putToS3({
          key: videoKey,
          body: stitchedBytes,
          contentType: "video/mp4",
        });
        await insertAsset({
          articleId,
          type: "video",
          url: videoUrl,
          s3Key: videoKey,
          mimeType: "video/mp4",
          durationSec: 16,
        });
        console.log(`[${nowIso()}] [OK] Video asset inserted (${videoUrl})`);
      } catch (err) {
        console.warn(
          `[${nowIso()}] [WARN] Video generation skipped:`,
          err?.message || err
        );
      }
    }

    // 3) AUDIO: narration from prompt
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

    const { rows } = await client.query(
      "select id, slug, status, createdAt from articles where slug=$1 limit 1",
      [slug]
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
