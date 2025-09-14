import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp"; // ok since you've installed it

// ---- Smart-crop feature flags (env) ----
const FACE_SMART_CROP = process.env.FACE_SMART_CROP === "true"; // enable/disable
const FACE_SMART_SIZE = Number(process.env.FACE_SMART_SIZE || 640); // crop size px

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002";
const VIDEO_MODEL =
  process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-preview";

const TMP_DIR = process.env.TMPDIR || "/tmp";

/* -----------------------------------------------------------
   Prompt wrappers for platform fit and identity conditioning
----------------------------------------------------------- */
const PLATFORM_WRAPPER = `
SYSTEM PURPOSE:
Synthesize a new 9:16 (1080×1920, 30 fps) video that matches the described effect. Always render on a fresh canvas.

PLATFORM FIT (IG Reels, Facebook Reels, TikTok)
• Output MP4 (H.264) with AAC audio.
• 9:16 vertical, 1080×1920, 30 fps (constant), duration as requested by EFFECT PROMPT (or 8–10s if not specified).
• Fill the frame (no letterbox/pillarbox). No burned-in captions or logos.
• Keep critical action inside central safe area; avoid top ~12% and bottom ~18%.
• Maintain consistent camera language, pacing and lighting.

CANVAS & FRAMING:
• Always start from a blank 1080×1920 canvas. Never reuse the uploaded photo’s background, FOV or aspect.
• Center-frame portrait, chest-up unless EFFECT PROMPT says otherwise.
• Locked tripod or gentle gimbal. No handheld shake.

NEGATIVE / AVOID:
• Do not add random people, watermarks, on-screen text or glitches.
• No borders or letterbox/pillarbox. No use of the upload’s environment.
`.trim();

const FACE_ONLY_ADDON = `
IDENTITY CONTROL (when a reference photo is provided):
• Use the uploaded image ONLY to extract face identity (age, skin tone, hair). Do NOT copy its background, clothes, camera FOV, lens or lighting.
• If wardrobe is unspecified by EFFECT PROMPT, use neutral, texture-light clothing that does not match the upload.
• Keep the same actor identity throughout. No face morphing.
• Rebuild the full scene according to EFFECT PROMPT; never sample pixels or composition from the uploaded image beyond face identity.
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

/* ---------------- Image (from the SAME Veo prompt) ---------------- */
export async function genImageBytes(prompt) {
  const resp = await ai.models.generateImages({
    model: IMAGE_MODEL,
    prompt,
  });

  const img = resp?.generatedImages?.[0]?.image;
  if (!img?.imageBytes) throw new Error("Imagen did not return image bytes");

  const bytes = Buffer.from(img.imageBytes, "base64");
  const mime = img.mimeType || "image/png";
  return { bytes, mime };
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

async function runVeoAndDownload({ prompt, imageBase64, imageMime }) {
  if (typeof ai?.models?.generateVideos !== "function") {
    throw new Error(
      "Video generation is unavailable in this @google/genai build"
    );
  }

  // call with or without image, depending on presence
  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    ...(imageBase64
      ? {
          image: {
            imageBytes: imageBase64,
            mimeType: imageMime || "image/jpeg",
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

  if (typeof video.uri === "string" && video.uri) {
    try {
      const bytes = await tryFetchUri(video.uri);
      return { bytes, mime: "video/mp4", durationSec: null };
    } catch (e) {
      console.warn(
        `[gemini] Veo URI fetch failed: ${e?.message || e}. Trying file id...`
      );
    }
  }

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
      return { bytes, mime: "video/mp4", durationSec: null };
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

/* ---------------- Optional smart identity crop ---------------- */
// Smart crop toward the most salient region (usually the face) and neutralize background detail.
async function smartIdentityCrop(buf) {
  if (!FACE_SMART_CROP) return buf; // feature off → no-op
  try {
    const square = await sharp(buf)
      .resize(FACE_SMART_SIZE, FACE_SMART_SIZE, {
        fit: "cover",
        position: "attention",
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    return square; // jpeg buffer
  } catch (e) {
    console.warn(
      "[gemini] smart crop failed, using original:",
      e?.message || e
    );
    return buf;
  }
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
  const ref = await smartIdentityCrop(sourceImageBytes);
  const fullPrompt = `${PLATFORM_WRAPPER}\n\n${FACE_ONLY_ADDON}\n\nEFFECT PROMPT:\n${effectPrompt}`;
  return runVeoAndDownload({
    prompt: fullPrompt,
    imageBase64: ref.toString("base64"),
    imageMime: "image/jpeg",
  });
}
