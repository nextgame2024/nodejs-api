import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const TEXT_MODEL = process.env.GEMINI_PLANNER_MODEL || "gemini-2.0-flash";

export async function genPreAssessmentSummary({ site, planning, proposal }) {
  const prompt = `
You are a Brisbane town planning assistant.

Generate a clear, client-friendly Pre-Assessment Summary for a domestic outbuilding (shed) proposal.
Base your answer ONLY on the JSON data provided. If something is unknown, say so explicitly.

Return your answer as JSON with this structure:
{
  "sections": [
    { "title": "Zoning & Neighbourhood Plan", "body": "..." },
    { "title": "Overlays & Triggers", "body": "..." },
    { "title": "Domestic Outbuilding Standards", "body": "..." },
    { "title": "Setbacks, Height & Site Cover", "body": "..." },
    { "title": "Earthworks & Stormwater", "body": "..." },
    { "title": "Overall Pre-Assessment", "body": "..." }
  ]
}

SITE:
${JSON.stringify(site, null, 2)}

PLANNING:
${JSON.stringify(planning, null, 2)}

PROPOSAL:
${JSON.stringify(proposal, null, 2)}
`;

  const resp = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const rawText =
    (resp?.response &&
      typeof resp.response.text === "function" &&
      resp.response.text()) ||
    resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error("[planner] Gemini JSON parse error:", err, rawText);
    throw new Error("Gemini returned invalid JSON for pre-assessment summary");
  }

  return parsed;
}
