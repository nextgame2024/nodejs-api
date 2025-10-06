import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp"; // installed

// ---- Smart-crop feature flags (env) ----
const FACE_SMART_CROP = process.env.FACE_SMART_CROP === "true"; // enable/disable
const FACE_SMART_SIZE = Number(process.env.FACE_SMART_SIZE || 640); // px (square)
const FACE_SMART_FEATHER = Number(process.env.FACE_SMART_FEATHER || 1.2); // mask blur radius

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ---- Models & video render config (env-overridable) ----
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002";
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-001";

// Portrait is the critical fix: Veo defaults to 16:9 if unspecified.
const VIDEO_ASPECT = process.env.GEMINI_VIDEO_ASPECT || "9:16"; // "9:16" | "16:9"
const VIDEO_DURATION_SEC = Number(process.env.GEMINI_VIDEO_DURATION_SEC || 8); // 8–16 typical

const TMP_DIR = process.env.TMPDIR || "/tmp";

/* -----------------------------------------------------------
   Prompt wrappers for platform fit and identity conditioning
----------------------------------------------------------- */
const PLATFORM_WRAPPER = `
SYSTEM PURPOSE:
Synthesize a **vertical 9:16** video that matches the described effect. Always render on a fresh canvas.

PLATFORM FIT (IG Reels, Facebook Reels, TikTok)
• Output MP4 (H.264) with AAC audio.
• Strict **9:16 portrait**, 30 fps (constant), duration 14–16 s unless otherwise stated.
• **Fill the frame** (no letterbox/pillarbox). No burned-in captions or logos.
• Keep critical action inside central safe area; avoid top ~12% and bottom ~18%.
• Maintain consistent camera language, pacing and lighting.

CANVAS & FRAMING:
• Start from a blank vertical canvas; do NOT reuse any background or aspect from the uploaded photo.
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

/* ---------------- Narration script from a Veo prompt ---------------- */
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

/* ---------------- Robust retry helper ---------------- */
async function retry(fn, attempts = 3, delayMs = 1500) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i))); // expo backoff
      }
    }
  }
  throw last;
}

/* ---------------- Image (from the SAME Veo prompt) ---------------- */
export async function genImageBytes(prompt) {
  return retry(async () => {
    const resp = await ai.models.generateImages({
      model: IMAGE_MODEL,
      prompt,
    });

    const img = resp?.generatedImages?.[0]?.image;
    if (!img?.imageBytes) {
      // Log shape to help diagnose occasional API shape shifts
      console.warn(
        "[gemini] Unexpected image payload:",
        JSON.stringify(resp)?.slice(0, 800)
      );
      throw new Error("Imagen did not return image bytes");
    }

    const bytes = Buffer.from(img.imageBytes, "base64");
    const mime = img.mimeType || "image/png";
    return { bytes, mime };
  });
}

/* ---------------- Video generators ---------------- */

/** Template-only video (no identity reference). Use for article teaser generation. */
export async function genVideoBytesFromPrompt(effectPrompt) {
  const fullPrompt = `${PLATFORM_WRAPPER}\n\nEFFECT PROMPT:\n${effectPrompt}`;
  return runVeoAndDownload({ prompt: fullPrompt });
}

/** Identity-conditioned video (user face). Use for paid renders. */
export async function genVideoBytesFromPromptAndImage(
  effectPrompt,
  sourceImageBytes
) {
  if (!sourceImageBytes) {
    // Fallback to template-only if no image provided
    return genVideoBytesFromPrompt(effectPrompt);
  }
  const { out: refBuf, mime: refMime } =
    await prepareIdentityRef(sourceImageBytes);
  const fullPrompt = `${PLATFORM_WRAPPER}\n\n${FACE_ONLY_ADDON}\n\nEFFECT PROMPT:\n${effectPrompt}`;
  return runVeoAndDownload({
    prompt: fullPrompt,
    imageBase64: refBuf.toString("base64"),
    imageMime: refMime, // PNG if masked (alpha), else JPEG
  });
}

/* ---------------- Helpers for Veo video download ---------------- */
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

/**
 * The single place that calls Veo.
 * IMPORTANT: we force portrait with aspectRatio "9:16".
 */
async function runVeoAndDownload({ prompt, imageBase64, imageMime }) {
  if (typeof ai?.models?.generateVideos !== "function") {
    throw new Error(
      "Video generation is unavailable in this @google/genai build"
    );
  }

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

  // Try direct URI first
  if (typeof video.uri === "string" && video.uri) {
    try {
      const bytes = await tryFetchUri(video.uri);
      return { bytes, mime: "video/mp4", durationSec: VIDEO_DURATION_SEC };
    } catch (e) {
      console.warn(
        `[gemini] Veo URI fetch failed: ${e?.message || e}. Trying file id...`
      );
    }
  }

  // Fallback to file-id download
  const candidates = [
    video.file?.name,
    video.file?.id,
    video.file,
    video.name,
    video.resourceName,
  ].filter((x) => typeof x === "string" && x);

  if (!candidates.length)
    throw new Error("Veo video has no uri/file identifier to download");

  let lastErr = null;
  for (const fileId of candidates) {
    try {
      const bytes = await tryDownloadFileId(fileId);
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

/* ---------------- Identity preparation: face-only PNG with alpha ---------------- */
async function prepareIdentityRef(buf) {
  if (!FACE_SMART_CROP) return { out: buf, mime: "image/jpeg" };

  try {
    // 1) Attention crop to square (keeps head/shoulders, reduces bg/outfit)
    const square = await sharp(buf)
      .resize(FACE_SMART_SIZE, FACE_SMART_SIZE, {
        fit: "cover",
        position: "attention",
      })
      .toBuffer();

    // 2) Build circular alpha mask (slight feather to avoid hard edge)
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

    // 3) Apply mask → transparent outside circle
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
