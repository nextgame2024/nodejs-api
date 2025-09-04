// src/services/gemini.js
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002";
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-preview";

const TMP_DIR = process.env.TMPDIR || "/tmp";

/* ---------------- Text (unchanged) ---------------- */
async function genJsonOnce(topic) {
  const prompt = `
You write a blog article for technology enthusiasts about: "${topic}".

Return ONLY valid minified JSON exactly like:
{"title": "...", "description":"...", "body":"...", "tagList":["a","b","c"]}

Rules:
- "title": short, compelling, no quotes.
- "description": 1–2 sentences, concise.
- "body": 600–1200 words, markdown allowed, no code fences in the JSON.
- "tagList": 4–8 lowercase kebab-case tags (e.g., ["ai-tools","rag","vector-search"]).
- No brand names, no logos, no personal data.
- Do not include any text outside the JSON object.
`;

  const resp = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    response_mime_type: "application/json",
  });

  const txt =
    (resp?.response &&
      typeof resp.response.text === "function" &&
      resp.response.text()) ||
    resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";

  return txt?.trim() || "";
}

/**
 * Generate one article JSON for a topic.
 * Always returns { title, description, body, tagList } with safe fallbacks.
 */
export async function genArticleJson(topic) {
  let raw = await genJsonOnce(topic);

  if (!raw) {
    const nudge = `
Return ONLY minified JSON: {"title":"...","description":"...","body":"...","tagList":["...","..."]}
Topic: ${topic}
`;
    const resp = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: "user", parts: [{ text: nudge }] }],
      response_mime_type: "application/json",
    });
    raw =
      (resp?.response &&
        typeof resp.response.text === "function" &&
        resp.response.text()) ||
      resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "";
    raw = raw.trim();
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }

  const title =
    (data.title && String(data.title).trim()) || `AI Notes: ${topic}`;
  const description =
    (data.description && String(data.description).trim()) ||
    `Quick take on ${topic} for tech enthusiasts.`;
  const body =
    (data.body && String(data.body).trim()) ||
    `# ${title}\n\nThis article explores **${topic}** for general technology enthusiasts.\n\n> (Auto-generated fallback content.)\n\n## Introduction\n\nComing soon.\n\n## Key Ideas\n\n- Idea 1\n- Idea 2\n- Idea 3\n\n## Conclusion\n\nMore in the next update.`;
  const tagList = Array.isArray(data.tagList)
    ? data.tagList
    : ["ai", "dev", "trends"];

  return { title, description, body, tagList };
}

/* ---------------- Image (unchanged) ---------------- */
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

/* ---------------- Video (hardened) ---------------- */
async function ensureTmpDir() {
  try {
    await fs.mkdir(TMP_DIR, { recursive: true });
  } catch (e) {
    // if /tmp exists already, ignore
  }
}

async function tryFetchUri(uri) {
  // Some Veo URIs require the API key header
  const resp = await fetch(uri, { headers: { "x-goog-api-key": GEMINI_API_KEY } });
  if (!resp.ok) {
    throw new Error(`URI fetch failed (${resp.status})`);
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function tryDownloadFileId(fileId) {
  await ensureTmpDir();
  const tmp = path.join(TMP_DIR, `veo_${Date.now()}.mp4`);
  await ai.files.download({ file: fileId, downloadPath: tmp });
  const bytes = await fs.readFile(tmp); // throws ENOENT if not written
  return bytes;
}

/**
 * Robust video generation and download:
 * - SDK LRO with polling
 * - Prefer direct URI (with API key header) if present
 * - Otherwise try multiple possible file identifiers via ai.files.download
 */
export async function genVideoBytesFromPromptAndImage(prompt, imageBytes) {
  if (typeof ai?.models?.generateVideos !== "function") {
    throw new Error("Video generation is unavailable in this @google/genai build");
  }

  // Start LRO
  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    image: {
      imageBytes: imageBytes.toString("base64"),
      mimeType: "image/png",
    },
  });

  // Poll until done
  while (!operation?.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const video = operation?.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error("Veo did not return a generated video");

  // Helpful debug: what fields did we get?
  try {
    const keys = Object.keys(video);
    console.log(`[gemini] video fields: ${keys.join(", ")}`);
  } catch {}

  // 1) Try URI (fast path)
  if (typeof video.uri === "string" && video.uri) {
    try {
      const bytes = await tryFetchUri(video.uri);
      return { bytes, mime: "video/mp4", durationSec: null };
    } catch (e) {
      console.warn(`[gemini] Veo URI fetch failed: ${e?.message || e}. Will try file download.`);
    }
  }

  // 2) Try file download with several likely identifiers
  const candidates = [
    video.file?.name,
    video.file?.id,
    video.file,
    video.name,
    video.resourceName,
    // Sometimes SDK returns nested shapes; add any other likely IDs here.
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
