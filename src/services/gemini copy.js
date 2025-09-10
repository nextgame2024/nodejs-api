// src/services/gemini.js
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const TEXT_MODEL  = process.env.GEMINI_TEXT_MODEL  || "gemini-2.0-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002";
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-preview";

const TMP_DIR = process.env.TMPDIR || "/tmp";

/* ---------------- Narration script from a Veo prompt ---------------- */
export async function genNarrationFromPrompt(veoPrompt) {
  const prompt = `Write a short, upbeat 1–2 sentence voiceover (max 28 words) describing the visual effect in second person. No quotes, no hashtags, brand-safe. Source inspiration is:\n\n${veoPrompt}`;
  const resp = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  const text =
    (resp?.response && typeof resp.response.text === "function" && resp.response.text()) ||
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

/* ---------------- Video (from the SAME Veo prompt + image conditioning) ---------------- */
async function ensureTmpDir() {
  try { await fs.mkdir(TMP_DIR, { recursive: true }); } catch {}
}

async function tryFetchUri(uri) {
  const resp = await fetch(uri, { headers: { "x-goog-api-key": GEMINI_API_KEY } });
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
 * Generate & download video bytes conditioned on the uploaded image (hero) and Veo prompt.
 */
export async function genVideoBytesFromPromptAndImage(prompt, imageBytes) {
  if (typeof ai?.models?.generateVideos !== "function") {
    throw new Error("Video generation is unavailable in this @google/genai build");
  }

  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    image: {
      imageBytes: imageBytes.toString("base64"),
      mimeType: "image/png",
    },
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
      console.warn(`[gemini] Veo URI fetch failed: ${e?.message || e}. Trying file id...`);
    }
  }

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
      const bytes = await tryDownloadFileId(fileId);
      return { bytes, mime: "video/mp4", durationSec: null };
    } catch (e) {
      lastErr = e;
      console.warn(`[gemini] ai.files.download failed for "${fileId}": ${e?.message || e}`);
    }
  }

  throw new Error(`All Veo download attempts failed: ${lastErr?.message || lastErr}`);
}
