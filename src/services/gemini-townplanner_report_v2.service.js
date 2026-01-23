// src/services/gemini-townplanner_report_v2.service.js

import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY env var is required");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const TEXT_MODEL =
  process.env.GEMINI_PLANNER_MODEL ||
  process.env.GEMINI_TEXT_MODEL ||
  "gemini-2.0-flash";

function stripFences(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function safeJsonParse(text) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export async function genTownPlannerReportNarrativeV2({
  schemeVersion,
  addressLabel,
  placeId,
  lat,
  lng,
  planning,
  controls,
}) {
  const prompt = `
You are producing content for a Brisbane property planning report.

You MUST base your analysis ONLY on:
1) Brisbane City Plan 2014 (and its mapping), and
2) the factual inputs provided below.

Rules:
- Do NOT invent numeric controls. If a control is not provided in controls.mergedControls, say "Not available from provided controls".
- Do NOT invent overlay presence; only reference overlays present in planning.overlays.
- Output MUST be strictly valid JSON (no markdown, no code fences).
- Use clear, plain-English guidance suitable for a property report.
- Keep each bullet concise and actionable.

SCHEME VERSION: ${schemeVersion}

FACTS (JSON):
${JSON.stringify({ addressLabel, placeId, lat, lng, planning, controls }, null, 2)}

Return JSON with this exact structure:
{
  "sections": [
    { "id":"overview", "title":"Property overview", "bullets":[...], "notes":[...] },
    { "id":"development", "title":"Development potential", "bullets":[...], "notes":[...] },
    { "id":"cautions", "title":"Potential cautions", "items":[ { "title": "...", "summary": "...", "implications":[...]} ] },
    { "id":"references", "title":"References", "items":[ "...short references/citation keys..." ] }
  ],
  "disclaimer": "..."
}
`.trim();

  const resp = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text =
    resp?.text ||
    resp?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") ||
    "";

  const parsed = safeJsonParse(text);

  if (parsed && typeof parsed === "object") return parsed;

  // Safe fallback
  return {
    sections: [
      {
        id: "overview",
        title: "Property overview",
        bullets: [],
        notes: ["Narrative generation failed; using factual data only."],
      },
      {
        id: "development",
        title: "Development potential",
        bullets: [],
        notes: [],
      },
      { id: "cautions", title: "Potential cautions", items: [] },
      { id: "references", title: "References", items: [schemeVersion] },
    ],
    disclaimer:
      "This report is a general planning guide only and does not constitute legal advice. Verify requirements against Brisbane City Plan 2014 mapping and applicable codes.",
  };
}
