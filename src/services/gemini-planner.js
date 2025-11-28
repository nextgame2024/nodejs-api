import genAI from "./gemini.js"; // export your configured client here

const TEXT_MODEL = process.env.GEMINI_PLANNER_MODEL || "gemini-2.0-pro";

export async function genPreAssessmentSummary({ site, planning, proposal }) {
  const model = genAI.getGenerativeModel({ model: TEXT_MODEL });

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

Here is the input data:

SITE:
${JSON.stringify(site, null, 2)}

PLANNING:
${JSON.stringify(planning, null, 2)}

PROPOSAL:
${JSON.stringify(proposal, null, 2)}
`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Let’s assume model returns valid JSON; in production, add try/catch and fallback.
  return JSON.parse(text);
}
