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
    .replace(/```$/i, "")
    .trim();
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
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-1.5-pro",
  });

  const prompt = `
You are producing content for a Brisbane property planning report.
You MUST base your analysis ONLY on:
1) Brisbane City Plan 2014 (and its mapping), and
2) the factual inputs provided below.

Rules:
- Do NOT invent numeric controls. If a control is not provided in controls.mergedControls, say "Not available from provided controls".
- Keep the output strictly valid JSON with the schema specified.
- Use clear, plain-English guidance suitable for a property report.

SCHEME VERSION: ${schemeVersion}

FACTS (JSON):
${JSON.stringify({ addressLabel, placeId, lat, lng, planning, controls }, null, 2)}

Return JSON with this exact structure:
{
  "sections": [
    { "id":"overview", "title":"Property overview", "bullets":[...], "notes":[...] },
    { "id":"development", "title":"Development potential", "bullets":[...], "notes":[...] },
    { "id":"cautions", "title":"Potential cautions", "items":[ { "title": "...", "summary": "...", "implications":[...]} ] },
    { "id":"references", "title":"References", "items":[ "...short references or citations keys..." ] }
  ],
  "disclaimer": "..."
}
  `.trim();

  const resp = await model.generateContent(prompt);
  const text = stripFences(
    resp?.response?.text?.() || resp?.response?.text || ""
  );

  try {
    return JSON.parse(text);
  } catch {
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
        "This report is a general planning guide only and does not constitute legal advice. For formal advice, consult Brisbane City Council and/or a qualified planning professional.",
    };
  }
}
