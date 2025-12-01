import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Prefer a specific model for planner if set; otherwise reuse text model.
const TEXT_MODEL =
  process.env.GEMINI_PLANNER_MODEL ||
  process.env.GEMINI_TEXT_MODEL ||
  "gemini-2.0-flash";

/**
 * Fallback deterministic summary (no AI) – used if Gemini JSON is invalid.
 */
function buildFallbackSummary({ site, planning, proposal }) {
  const address = site.address || "the subject site";
  const zoning = planning.zoning || "Unknown zoning";
  const np = planning.neighbourhoodPlan || "No neighbourhood plan identified";

  const shedDescParts = [];
  if (proposal.lengthM && proposal.widthM) {
    shedDescParts.push(`${proposal.lengthM} m × ${proposal.widthM} m`);
  }
  if (proposal.heightRidgeM) {
    shedDescParts.push(`ridge height ${proposal.heightRidgeM} m`);
  }
  if (proposal.heightWallM) {
    shedDescParts.push(`wall height ${proposal.heightWallM} m`);
  }
  const shedDesc = shedDescParts.join(", ") || "domestic outbuilding";

  const overlaysText =
    planning.overlays && planning.overlays.length
      ? planning.overlays
          .map((o) => (o.severity ? `${o.name} (${o.severity})` : o.name))
          .join("; ")
      : "No overlays identified in this pre-assessment (subject to detailed search).";

  return {
    sections: [
      {
        title: "Zoning & Neighbourhood Plan",
        body: `The site at ${address} is located within the ${zoning} zone under Brisbane City Plan 2014. The applicable neighbourhood plan mapping indicates ${np}. This pre-assessment is based on this zoning context and does not replace a full Council property search.`,
      },
      {
        title: "Overlays & Triggers",
        body: `Based on the preliminary overlay review, the following overlays are noted for the site: ${overlaysText}.\n\nThese overlays may introduce additional assessment benchmarks and/or code triggers. A full City Plan and state mapping search is recommended before lodgement.`,
      },
      {
        title: "Domestic Outbuilding Standards",
        body: `The proposal is for a ${shedDesc} domestic outbuilding intended for ${
          proposal.purpose || "domestic storage/ancillary use"
        }. Materials are described as ${
          proposal.materials || "typical residential-scale materials"
        }.\n\nThis pre-assessment does not confirm full compliance with all relevant codes but provides an initial, high-level review.`,
      },
      {
        title: "Setbacks, Height & Site Cover",
        body: `Submitted setbacks are:\n- Front: ${
          proposal.setbacks?.front ?? "not provided"
        } m\n- Side 1: ${
          proposal.setbacks?.side1 ?? "not provided"
        } m\n- Side 2: ${
          proposal.setbacks?.side2 ?? "not provided"
        } m\n- Rear: ${
          proposal.setbacks?.rear ?? "not provided"
        } m\n\nOverall height and bulk appear generally consistent with a typical domestic shed for Low Density Residential zoning, however detailed assessment against all acceptable outcomes and performance outcomes is recommended.`,
      },
      {
        title: "Earthworks & Stormwater",
        body: `The pre-assessment notes earthworks of ${
          proposal.earthworks || "minor site regrading only"
        } and stormwater management described as ${
          proposal.stormwater || "connection to lawful point of discharge"
        }.\n\nAny cut/fill or drainage work must be designed to maintain stability of adjoining properties and ensure no worsening of stormwater impacts.`,
      },
      {
        title: "Overall Pre-Assessment",
        body: `On a preliminary review, the proposal appears capable of being supported in principle as a domestic outbuilding in the ${zoning} zone, subject to confirmation of setbacks, building height, site coverage and overlay responses against City Plan 2014 codes and any state planning interests.\n\nThis document is an initial pre-assessment only and should not be relied upon as a formal planning approval or detailed planning advice.`,
      },
    ],
  };
}

/**
 * Call Gemini to generate a JSON summary. If parsing fails, fall back to
 * buildFallbackSummary so the user always gets something.
 */
export async function genPreAssessmentSummary({ site, planning, proposal }) {
  const prompt = `
You are a Brisbane town planning assistant.

Generate a clear, client-friendly Pre-Assessment Summary for a domestic outbuilding (shed) proposal.

IMPORTANT OUTPUT RULES:
- Respond with **JSON ONLY**.
- Do NOT include Markdown, backticks, commentary, or explanations.
- The JSON must match this exact structure:

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

SITE DATA:
${JSON.stringify(site, null, 2)}

PLANNING DATA:
${JSON.stringify(planning, null, 2)}

PROPOSAL DATA:
${JSON.stringify(proposal, null, 2)}
`;

  try {
    const resp = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
      },
    });

    let rawText =
      (resp?.response &&
        typeof resp.response.text === "function" &&
        resp.response.text()) ||
      resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "";

    rawText = String(rawText).trim();

    // Strip ```json ... ``` if the model ignored our instructions
    if (rawText.startsWith("```")) {
      rawText = rawText.replace(/^```json/i, "").replace(/^```/, "");
      rawText = rawText.replace(/```$/, "").trim();
    }

    const parsed = JSON.parse(rawText);
    if (!parsed || !Array.isArray(parsed.sections)) {
      throw new Error("Parsed JSON missing sections array");
    }

    return parsed;
  } catch (err) {
    console.error(
      "[planner] Gemini JSON parse failed, using fallback:",
      err?.message || err
    );
    return buildFallbackSummary({ site, planning, proposal });
  }
}
