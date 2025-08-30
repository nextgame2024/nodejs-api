import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Choose models (tweak if you like)
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002";
const VIDEO_MODEL =
  process.env.GEMINI_VIDEO_MODEL || "veo-3.0-generate-preview";

/**
 * Generate one article (JSON) for a topic.
 * Returns { title, description, body, tagList }
 */
export async function genArticleJson(topic) {
  const prompt = `
You are writing a blog article for technology enthusiasts about: "${topic}".
Return ONLY valid JSON matching:
{
  "title": string,
  "description": string,
  "body": string,      // 600-1200 words, markdown allowed
  "tagList": string[]  // 3-6 lowercase tags
}
Constraints:
- Short, compelling title.
- Be original, practical, accurate.
- No personal data.
- No brand names or logos.
- Target general technology enthusiasts.
- 5–8 relevant tags (kebab-case)
`;
  const resp = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    // Instruct the service to return JSON text
    response_mime_type: "application/json",
  });

  const txt =
    resp?.response?.text?.() ??
    resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ??
    "{}";

  // Be defensive parsing JSON
  try {
    const data = JSON.parse(txt);
    data.tagList = Array.isArray(data.tagList) ? data.tagList : [];
    return data;
  } catch (e) {
    throw new Error(
      `Failed to parse article JSON: ${e.message}. Raw: ${txt.slice(0, 200)}…`
    );
  }
}

/** Generate 1 image (PNG bytes) using Imagen 3 via Gemini API */
export async function genImageBytes(prompt) {
  const resp = await ai.models.generateImages({
    model: IMAGE_MODEL,
    prompt,
    negativePrompt:
      "logos, brands, text overlays, watermarks, low quality, extra fingers, distorted anatomy",
    // small, fast – adjust as you like
    aspectRatio: "16:9",
  });
  const img = resp?.generatedImages?.[0]?.image;
  if (!img?.imageBytes) {
    throw new Error("Imagen did not return image bytes");
  }
  const buf = Buffer.from(img.imageBytes, "base64");
  // SDK returns MIME via image.mimeType in some versions; if missing, assume PNG
  const mime = img.mimeType || "image/png";
  return { bytes: buf, mime };
}

/** Generate short video with Veo 3 in preview (8s, 720p) using the image as init frame */
export async function genVideoBytesFromPromptAndImage(prompt, imageBytes) {
  // 1) start op
  let op = await ai.models.generateVideos({
    model: VIDEO_MODEL,
    prompt,
    image: { imageBytes, mimeType: "image/png" },
    config: {
      aspectRatio: "16:9",
      negativePrompt: "logos, brands, text overlays, watermarks, low quality",
    },
  });

  // 2) poll
  while (!operation.done) {
    await new Promise((r) => setTimeout(r, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const videoObj = operation?.response?.generatedVideos?.[0]?.video;
  if (!videoObj) {
    throw new Error("Veo did not return a generated video");
  }

  // 3) download the file locally then return bytes
  const tmp = path.join("/tmp", `veo_${Date.now()}.mp4`);
  await ai.files.download({ file: videoObj, downloadPath: tmp });
  const bytes = await fs.readFile(tmp);
  const mime = "video/mp4";

  // If the API returns metadata with duration you can extract it here; otherwise null
  return { bytes, mime, durationSec: null };
}
