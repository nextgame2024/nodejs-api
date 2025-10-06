import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

// -------------------- ENV / CLIENT --------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Models (overridable)
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002";
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-001";

// Portrait authority (Veo defaults to 16:9 if unspecified)
const VIDEO_ASPECT = process.env.GEMINI_VIDEO_ASPECT || "9:16"; // "9:16" | "16:9"
const VIDEO_DURATION_SEC = Number(process.env.GEMINI_VIDEO_DURATION_SEC || 8); // 8–16 typical

// Optional post step to guarantee true 1080x1920 portrait (kills baked-in bars)
const ENABLE_VERTICAL_ENFORCER = process.env.ENABLE_VERTICAL_ENFORCER === "1";
const ENFORCER_ZOOM = Number(process.env.ENFORCER_ZOOM || 1.08); // 1.04–1.12 usually safe

const TMP_DIR = process.env.TMPDIR || "/tmp";

// Smart face-crop for identity refs (optional)
const FACE_SMART_CROP = process.env.FACE_SMART_CROP === "true";
const FACE_SMART_SIZE = Number(process.env.FACE_SMART_SIZE || 640);
const FACE_SMART_FEATHER = Number(process.env.FACE_SMART_FEATHER || 1.2);

// -------------------- Prompt wrappers --------------------
const PLATFORM_WRAPPER = `
SYSTEM PURPOSE:
Synthesize a **vertical 9:16** video that matches the described effect. Always render on a fresh portrait canvas.

PLATFORM FIT (IG Reels, Facebook Reels, TikTok)
• Output MP4 (H.264) with AAC audio.
• Strict **9:16 portrait**, 30 fps (constant), duration 8–16 s (see timing).
• **Fill the frame** (no letterbox/pillarbox). No burned-in captions or logos.
• Keep critical action inside central safe area; avoid top ~12% and bottom ~18%.
• Maintain consistent camera language, pacing and lighting.

CANVAS & FRAMING:
• Start from a blank vertical canvas; do NOT reuse any background/aspect from the uploaded photo.
• Center-frame portrait, chest-up unless EFFECT PROMPT says otherwise.
• Locked tripod or gentle gimbal. No handheld shake.

NEGATIVE / AVOID:
• No extra people, watermarks, on-screen text or glitches.
• No borders or cinematic bars. Do not adopt the upload’s environment.
`.trim();

const FACE_ONLY_ADDON = `
IDENTITY CONTROL (when a reference photo is provided):
• Use the uploaded image ONLY for face identity (age, skin tone, hair). Do NOT copy its background, clothes, camera FOV, lens or lighting.
• If wardrobe is unspecified by EFFECT PROMPT, use neutral, texture-light clothing that does not match the upload.
• Keep the same actor identity throughout. No face morphing or age/gender/skin-tone drift.
• Rebuild the full scene according to EFFECT PROMPT; never sample composition from the uploaded image beyond face identity.
`.trim();

// -------------------- Public helpers --------------------
export async function genNarrationFromPrompt(veoPrompt) {
  const prompt = `Write a short, upbeat 1–2 sentence voiceover (max 28 words) describing the visual effect in second person. No quotes, no hashtags, brand-safe. Source inspiration is:\n\n${veoPrompt}`;
  const resp = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  const text =
    (resp?.response &&
      typeof resp.response.text === "function" &&
      resp.response.text()) ||
    resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";
  return String(text || "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/[\n\r]+/g, " ")
    .slice(0, 220)
    .trim();
}

export async function genImageBytes(prompt) {
  const resp = await ai.models.generateImages({
    model: IMAGE_MODEL,
    prompt,
  });

  const img = resp?.generatedImages?.[0]?.image;
  if (!img?.imageBytes) {
    console.warn(
      "[gemini] Unexpected image payload:",
      JSON.stringify(resp)?.slice(0, 800)
    );
    throw new Error("Imagen did not return image bytes");
  }

  const bytes = Buffer.from(img.imageBytes, "base64");
  const mime = img.mimeType || "image/png";
  return { bytes, mime };
}

// For article teaser generation (no identity image)
export async function genVideoBytesFromPrompt(effectPrompt) {
  const fullPrompt = `${PLATFORM_WRAPPER}\n\nEFFECT PROMPT:\n${effectPrompt}`;
  return runVeoAndDownload({ prompt: fullPrompt });
}

// Identity-conditioned video (use user face)
export async function genVideoBytesFromPromptAndImage(
  effectPrompt,
  sourceImageBytes
) {
  if (!sourceImageBytes) return genVideoBytesFromPrompt(effectPrompt);

  const { out: refBuf, mime: refMime } =
    await prepareIdentityRef(sourceImageBytes);

  const fullPrompt = `${PLATFORM_WRAPPER}\n\n${FACE_ONLY_ADDON}\n\nEFFECT PROMPT:\n${effectPrompt}`;

  return runVeoAndDownload({
    prompt: fullPrompt,
    imageBase64: refBuf.toString("base64"),
    imageMime: refMime, // PNG when masked, else JPEG
  });
}

// -------------------- Internal helpers --------------------
async function ensureTmpDir() {
  try {
    await fs.mkdir(TMP_DIR, { recursive: true });
  } catch {}
}

async function tryFetchUri(uri) {
  const resp = await fetch(uri, {
    headers: { "x-goog-api-key": GEMINI_API_KEY },
  });
  if (!resp.ok) throw new Error(`URI fetch failed (${resp.status})`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function tryDownloadFileId(fileId) {
  await ensureTmpDir();
  const tmp = path.join(TMP_DIR, `veo_${Date.now()}.mp4`);
  await ai.files.download({ file: fileId, downloadPath: tmp });
  const bytes = await fs.readFile(tmp);
  return bytes;
}

// Optional: guaranteed portrait fill (kills baked-in bars)
async function enforcePortraitFill(inputBytes) {
  if (!ENABLE_VERTICAL_ENFORCER) return inputBytes;

  await ensureTmpDir();
  const inPath = path.join(TMP_DIR, `in_${Date.now()}.mp4`);
  const outPath = path.join(TMP_DIR, `out_${Date.now()}.mp4`);
  await fs.writeFile(inPath, inputBytes);

  const zoom = Math.max(1.0, Math.min(1.2, ENFORCER_ZOOM));
  // Zoom slightly, keep aspect, crop to exact 1080x1920, and lock 30fps
  const vf = [
    "setsar=1",
    `scale=ceil(iw*${zoom}/2)*2:ceil(ih*${zoom}/2)*2`,
    "crop=1080:1920",
    "fps=30",
  ].join(",");

  try {
    await pExecFile("ffmpeg", [
      "-y",
      "-i",
      inPath,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "medium",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outPath,
    ]);
    const out = await fs.readFile(outPath);
    return out;
  } catch (e) {
    console.warn("[gemini] ffmpeg portrait enforcer failed:", e?.message || e);
    return inputBytes;
  } finally {
    try {
      await fs.rm(inPath, { force: true });
    } catch {}
    try {
      await fs.rm(outPath, { force: true });
    } catch {}
  }
}

/**
 * Single place that calls Veo 3.
 * IMPORTANT: Put video settings under "config". Do NOT send "resolution" (API rejects it).
 */
async function runVeoAndDownload({ prompt, imageBase64, imageMime }) {
  if (typeof ai?.models?.generateVideos !== "function") {
    throw new Error(
      "Video generation is unavailable in this @google/genai build"
    );
  }

  // Request portrait via config (authoritative)
  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    config: {
      aspectRatio: VIDEO_ASPECT, // "9:16" to force portrait
      durationSeconds: VIDEO_DURATION_SEC,
    },
    ...(imageBase64
      ? {
          image: {
            imageBytes: imageBase64,
            mimeType: imageMime || "image/png",
          },
        }
      : {}),
  });

  while (!operation?.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const video = operation?.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error("Veo did not return a generated video");

  // Prefer direct URI
  if (typeof video.uri === "string" && video.uri) {
    try {
      let bytes = await tryFetchUri(video.uri);
      bytes = await enforcePortraitFill(bytes); // kill baked-in bars if any
      return { bytes, mime: "video/mp4", durationSec: VIDEO_DURATION_SEC };
    } catch (e) {
      console.warn(
        `[gemini] URI fetch failed: ${e?.message || e}. Trying file id...`
      );
    }
  }

  // Fallback: download by file id
  const candidates = [
    video.file?.name,
    video.file?.id,
    video.file,
    video.name,
    video.resourceName,
  ].filter((x) => typeof x === "string" && x);

  if (!candidates.length) {
    throw new Error("Veo video has no uri/file identifier to download");
  }

  let lastErr = null;
  for (const fileId of candidates) {
    try {
      let bytes = await tryDownloadFileId(fileId);
      bytes = await enforcePortraitFill(bytes);
      return { bytes, mime: "video/mp4", durationSec: VIDEO_DURATION_SEC };
    } catch (e) {
      lastErr = e;
      console.warn(
        `[gemini] ai.files.download failed for "${fileId}": ${e?.message || e}`
      );
    }
  }

  throw new Error(
    `All Veo download attempts failed: ${lastErr?.message || lastErr}`
  );
}

// -------------------- Identity prep (optional) --------------------
async function prepareIdentityRef(buf) {
  if (!FACE_SMART_CROP) return { out: buf, mime: "image/jpeg" };

  try {
    // 1) Attention crop to square (head/shoulders)
    const square = await sharp(buf)
      .resize(FACE_SMART_SIZE, FACE_SMART_SIZE, {
        fit: "cover",
        position: "attention",
      })
      .toBuffer();

    // 2) Soft circular alpha mask to de-emphasize clothing/background
    const size = FACE_SMART_SIZE;
    const r = Math.floor(size * 0.42);
    const cx = Math.floor(size / 2);
    const cy = Math.floor(size / 2);
    const svg = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
         <defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
           <stop offset="${Math.max(0, 1 - FACE_SMART_FEATHER / 10).toFixed(2)}" stop-color="#ffffff"/>
           <stop offset="1" stop-color="#000000"/>
         </radialGradient></defs>
         <rect width="100%" height="100%" fill="#000"/>
         <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g)"/>
       </svg>`
    );
    const maskPng = await sharp(svg).png().toBuffer();

    const cutout = await sharp(square)
      .composite([{ input: maskPng, blend: "dest-in" }])
      .png()
      .toBuffer();

    return { out: cutout, mime: "image/png" };
  } catch (e) {
    console.warn(
      "[gemini] prepareIdentityRef failed, using original:",
      e?.message || e
    );
    return { out: buf, mime: "image/jpeg" };
  }
}
