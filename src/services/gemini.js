import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/** Generate a JSON article (title, description, body, tagList) */
export async function genArticleJson(topic) {
  const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
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
- Be original, practical, accurate.
- No personal data.
- No brand names or logos.
- Target general dev audience.
`;
  const res = await model.generateContent(prompt);
  const text = res.response.text();
  // best-effort parse
  const json = JSON.parse(text.replace(/```json|```/g, "").trim());
  return json;
}

/** Generate 1 image (PNG bytes) using Imagen 3 via Gemini API */
export async function genImageBytes(prompt) {
  const resp = await ai.models.generateImages({
    model: "imagen-3.0-generate-002",
    prompt,
    negativePrompt:
      "logos, brands, text overlays, watermarks, low quality, extra fingers, distorted anatomy",
    // small, fast – adjust as you like
    aspectRatio: "16:9",
  });
  const img = resp.generatedImages?.[0]?.image;
  if (!img?.imageBytes) throw new Error("Image generation failed");
  // image.mimeType is typically "image/png"
  return {
    bytes: Buffer.from(img.imageBytes, "base64"),
    mime: img.mimeType || "image/png",
  };
}

/** Generate short video with Veo 3 in preview (8s, 720p) using the image as init frame */
export async function genVideoBytesFromPromptAndImage(prompt, imageBytes) {
  // 1) start op
  let op = await ai.models.generateVideos({
    model: "veo-3.0-generate-preview",
    prompt,
    image: { imageBytes, mimeType: "image/png" },
    config: {
      aspectRatio: "16:9",
      negativePrompt: "logos, brands, text overlays, watermarks, low quality",
    },
  });

  // 2) poll
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 8000));
    op = await ai.operations.getVideosOperation({ operation: op });
  }

  // 3) download
  const fileRef = op.response?.generatedVideos?.[0]?.video;
  if (!fileRef) throw new Error("Veo video missing");
  // save to buffer (downloadPath would stream to disk; we want bytes)
  const downloaded = await ai.files.download({ file: fileRef });
  const chunks = [];
  for await (const chunk of downloaded.stream) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  return { bytes: buf, mime: "video/mp4", durationSec: 8 };
}
