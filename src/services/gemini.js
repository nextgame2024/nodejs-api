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
const VIDEO_MODEL =
  process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-preview";

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
 * Always returns { title, description, body, tagList }
 * with safe fallbacks if parsing fails.
 */
export async function genArticleJson(topic) {
  // First attempt
  let raw = await genJsonOnce(topic);

  // Retry once with a stricter reminder if empty/invalid
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

  // Parse defensively
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }

  // Sane fallbacks to avoid NULLs
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

/* ---------- IMAGE ---------- */
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

/* ---------- VIDEO ---------- */
export async function genVideoBytesFromPromptAndImage(prompt, imageBytes) {
  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    image: {
      imageBytes: imageBytes.toString("base64"),
      mimeType: "image/png",
    },
  });

  while (!operation.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const videoObj = operation?.response?.generatedVideos?.[0]?.video;
  if (!videoObj) throw new Error("Veo did not return a generated video");

  const tmp = path.join("/tmp", `veo_${Date.now()}.mp4`);
  await ai.files.download({ file: videoObj, downloadPath: tmp });
  const bytes = await fs.readFile(tmp);
  return { bytes, mime: "video/mp4", durationSec: null };
}
