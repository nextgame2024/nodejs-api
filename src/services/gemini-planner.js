import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY env var is required");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const TEXT_MODEL =
  process.env.GEMINI_PLANNER_MODEL ||
  process.env.GEMINI_TEXT_MODEL ||
  "gemini-2.0-flash";

const SCHEMA_VERSION = 2;

function safeText(v, fallback = "") {
  const s = v == null ? "" : String(v).trim();
  return s ? s : fallback;
}

function normalizeStatus(v) {
  const s = safeText(v, "").toLowerCase();
  if (["pass", "unknown", "trigger", "fail"].includes(s)) return s;
  if (["info", "ok", "provided"].includes(s)) return "pass";
  if (["risk", "attention"].includes(s)) return "trigger";
  return "unknown";
}

function stripCodeFences(raw) {
  let t = String(raw || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```json/i, "").replace(/^```/i, "");
    t = t.replace(/```$/, "").trim();
  }
  return t;
}

function validateV2(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (!parsed.executiveSummary || typeof parsed.executiveSummary !== "object")
    return false;
  if (!parsed.planningControls || typeof parsed.planningControls !== "object")
    return false;
  if (!Array.isArray(parsed.assessmentChecklist)) return false;
  if (!Array.isArray(parsed.assumptionsAndUnknowns)) return false;
  if (typeof parsed.disclaimer !== "string") return false;
  return true;
}

/**
 * Fallback deterministic summary (no AI) – schema v2.
 */
function buildFallbackSummary({
  site,
  planning,
  proposal,
  classification,
  checks,
}) {
  const address = safeText(site?.address, "the subject site");

  const outcome = {
    devType: classification?.devType || "Unknown",
    assessmentLevel: classification?.assessmentLevel || "Unknown",
    confidence: "low",
  };

  const overlayHints = Array.isArray(checks?.overlayHints)
    ? checks.overlayHints
    : [];

  const keyFindings = [];
  for (const o of overlayHints.slice(0, 3)) {
    keyFindings.push({
      severity: safeText(o?.severity, "info"),
      title: safeText(o?.name, "Overlay"),
      detail: safeText(o?.whyItMatters, ""),
    });
  }

  const missing = Array.isArray(checks?.missingInputs)
    ? checks.missingInputs
    : [];
  if (missing.length) {
    keyFindings.push({
      severity: "medium",
      title: "Missing inputs",
      detail:
        "Some critical inputs are not provided. This reduces confidence in the assessment.",
    });
  }

  const recommendedNextSteps = Array.isArray(checks?.recommendedNextSteps)
    ? checks.recommendedNextSteps
    : [
        "Confirm zoning and overlay mapping using Brisbane City Council City Plan mapping.",
        "Confirm parcel boundaries and any easements/encumbrances from title and survey information.",
        "Confirm key proposal inputs (dimensions, height and setbacks) and assess against applicable benchmarks.",
      ];

  const checklist = Array.isArray(checks?.items)
    ? checks.items.map((it) => ({
        topic: safeText(it?.label, "Item"),
        benchmarkRef: "",
        status: normalizeStatus(it?.status),
        evidence: safeText(it?.details, ""),
        comment:
          "Confirm against City Plan provisions and/or certifier advice.",
      }))
    : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    executiveSummary: {
      headline: `Preliminary pre-assessment for ${address}.`,
      assessmentOutcome: outcome,
      keyFindings,
      recommendedNextSteps,
    },
    planningControls: {
      zoning: {
        name: safeText(planning?.zoning, "Unknown zoning"),
        code: safeText(planning?.zoningCode, ""),
        rationale:
          "Zoning identified from available mapping; confirm with Council property search.",
      },
      neighbourhoodPlan: {
        name: safeText(planning?.neighbourhoodPlan, ""),
        precinct: safeText(planning?.neighbourhoodPlanPrecinct, ""),
        rationale: safeText(planning?.neighbourhoodPlan)
          ? "Neighbourhood plan mapping identified from available data."
          : "No neighbourhood plan identified in this lookup; confirm with Council mapping.",
      },
      overlays: overlayHints,
    },
    assessmentChecklist: checklist,
    assumptionsAndUnknowns: missing,
    disclaimer:
      "This pre-assessment is guidance only and does not constitute planning approval or legal advice. Confirm requirements with Brisbane City Council and a qualified professional.",
  };
}

/**
 * Call Gemini to generate a structured JSON summary (schema v2).
 */
export async function genPreAssessmentSummary({
  site,
  planning,
  proposal,
  classification,
  checks,
}) {
  const prompt = `
You are a Brisbane town planning assistant producing a professional-style pre-assessment report.

The user is proposing a DOMESTIC OUTBUILDING (shed) at a residential property in Brisbane.

Your job:
1) Summarise the likely planning context (zoning, neighbourhood plan, overlays).
2) Provide a concise executive summary with clear findings and next steps.
3) Provide a structured assessment checklist that flags missing information and likely triggers.

CRITICAL RULES:
- Output JSON ONLY.
- Do NOT output markdown, backticks, commentary or explanations.
- Do NOT invent numbers, dimensions, heights, setbacks, areas, or claims not present in the input.
- If information is missing, set status to "unknown" and explain what is required.
- Use ONLY these status values: "pass", "unknown", "trigger", "fail".

OUTPUT SCHEMA (must match exactly):
{
  "schemaVersion": 2,
  "executiveSummary": {
    "headline": "string",
    "assessmentOutcome": {
      "devType": "string",
      "assessmentLevel": "string",
      "confidence": "low|medium|high"
    },
    "keyFindings": [
      { "severity": "low|medium|high|info", "title": "string", "detail": "string" }
    ],
    "recommendedNextSteps": ["string"]
  },
  "planningControls": {
    "zoning": { "name": "string", "code": "string", "rationale": "string" },
    "neighbourhoodPlan": { "name": "string", "precinct": "string", "rationale": "string" },
    "overlays": [
      {
        "code": "string",
        "name": "string",
        "severity": "low|medium|high|info",
        "whyItMatters": "string",
        "actions": ["string"]
      }
    ]
  },
  "assessmentChecklist": [
    {
      "topic": "string",
      "benchmarkRef": "string",
      "status": "pass|unknown|trigger|fail",
      "evidence": "string",
      "comment": "string"
    }
  ],
  "assumptionsAndUnknowns": ["string"],
  "disclaimer": "string"
}

INPUT DATA (do not repeat verbatim in full; extract what matters):

SITE:
${JSON.stringify(site || {}, null, 2)}

PLANNING (includes geocode + zoning + neighbourhood plan + overlays):
${JSON.stringify(planning || {}, null, 2)}

PROPOSAL:
${JSON.stringify(proposal || {}, null, 2)}

CLASSIFICATION (deterministic):
${JSON.stringify(classification || {}, null, 2)}

DETERMINISTIC CHECKS (use these as the factual base):
${JSON.stringify(checks || {}, null, 2)}
`;

  try {
    const resp = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 },
    });

    let rawText =
      (resp?.response &&
        typeof resp.response.text === "function" &&
        resp.response.text()) ||
      resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "";

    rawText = stripCodeFences(rawText);

    const parsed = JSON.parse(rawText);
    if (!validateV2(parsed)) {
      throw new Error("Parsed JSON did not match schema v2");
    }

    if (Array.isArray(parsed.assessmentChecklist)) {
      parsed.assessmentChecklist = parsed.assessmentChecklist.map((c) => ({
        ...c,
        status: normalizeStatus(c?.status),
      }));
    }

    parsed.schemaVersion = SCHEMA_VERSION;
    return parsed;
  } catch (err) {
    console.error(
      "[planner] Gemini JSON parse failed, using fallback:",
      err?.message || err
    );
    return buildFallbackSummary({
      site,
      planning,
      proposal,
      classification,
      checks,
    });
  }
}
