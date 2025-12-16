// src/services/preAssessmentChecks.service.js

/**
 * Deterministic (non-LLM) checks.
 *
 * Status values used throughout:
 * - pass: information provided / condition met
 * - unknown: missing inputs or insufficient data
 * - trigger: mapped constraint likely introduces extra requirements
 * - fail: clear non-compliance based on provided inputs (rare in v1)
 */

function isNum(v) {
  return v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));
}

function safeText(v, fallback = "") {
  const s = v == null ? "" : String(v).trim();
  return s ? s : fallback;
}

function normalizeSeverity(sev) {
  const s = safeText(sev, "").toLowerCase();
  if (!s) return "info";
  if (["high", "medium", "low"].includes(s)) return s;
  return "info";
}

function detectOverlayFlags(planning) {
  const overlays = Array.isArray(planning?.overlays) ? planning.overlays : [];
  const text = overlays
    .map((o) => `${safeText(o?.code)} ${safeText(o?.name)}`.toLowerCase())
    .join(" | ");

  const hasFlood = /flood|overland/.test(text);
  const hasNoise =
    /noise/.test(text) || Boolean(planning?.hasTransportNoiseCorridor);

  return { overlays, hasFlood, hasNoise };
}

function overlayHintFor(o, flags) {
  const code = safeText(o?.code, "");
  const name = safeText(o?.name, code || "Overlay");
  const base = `${code} ${name}`.toLowerCase();

  const hint = {
    code: code || undefined,
    name,
    severity: normalizeSeverity(o?.severity),
    whyItMatters: "",
    actions: [],
  };

  if (/flood|overland/.test(base)) {
    hint.severity = hint.severity === "info" ? "high" : hint.severity;
    hint.whyItMatters =
      "Mapped flooding/overland flow constraints may introduce additional siting, floor level, materials and drainage requirements, and can affect building location and construction method.";
    hint.actions = [
      "Confirm flood/overland flow mapping on BCC City Plan and Queensland Globe.",
      "Check the relevant overlay code benchmarks and whether hydraulic advice is required.",
      "Confirm finished floor levels, freeboard and safe access/egress considerations (if applicable).",
    ];
    return hint;
  }

  if (/noise|transport/.test(base) || flags.hasNoise) {
    hint.severity = hint.severity === "info" ? "medium" : hint.severity;
    hint.whyItMatters =
      "Transport noise mapping may introduce acoustic design considerations, building orientation controls, and additional code requirements for habitable spaces.";
    hint.actions = [
      "Confirm whether the proposal includes habitable spaces (domestic shed usually non-habitable).",
      "Review the Transport noise corridor overlay code benchmarks.",
      "If triggered, consider an acoustic report or building design response.",
    ];
    return hint;
  }

  // Default overlay handling
  hint.whyItMatters =
    "Mapped overlays may introduce additional assessment benchmarks and/or code triggers. Confirm the applicable overlay code(s) and required evidence.";
  hint.actions = [
    "Confirm overlay mapping and applicable overlay code(s).",
    "Identify required supporting documents (e.g., plans, reports) based on the overlay.",
  ];
  return hint;
}

function missingInputsFrom({ site, proposal }) {
  const missing = [];

  if (!safeText(site?.address))
    missing.push("Confirm the correct site address and property boundaries.");
  if (!safeText(proposal?.purpose))
    missing.push(
      "Confirm the outbuilding purpose/use (storage, workshop, etc.)."
    );

  if (!isNum(proposal?.lengthM) || !isNum(proposal?.widthM)) {
    missing.push(
      "Confirm the proposed outbuilding footprint (length and width in metres)."
    );
  }

  if (!isNum(proposal?.heightRidgeM) && !isNum(proposal?.heightWallM)) {
    missing.push(
      "Confirm proposed building height (ridge and/or wall height)."
    );
  }

  const sb = proposal?.setbacks || {};
  const missingSetbacks = [
    sb.front == null ? "front" : null,
    sb.rear == null ? "rear" : null,
    sb.side1 == null ? "side 1" : null,
    sb.side2 == null ? "side 2" : null,
  ].filter(Boolean);

  if (missingSetbacks.length) {
    missing.push(`Confirm setbacks (${missingSetbacks.join(", ")}).`);
  }

  return missing;
}

export function buildPreAssessmentChecks({
  site = {},
  proposal = {},
  planning = {},
  classification = null,
}) {
  const items = [];

  const add = (key, label, status, details = "") => {
    items.push({ key, label, status, details });
  };

  const flags = detectOverlayFlags(planning);

  // Basic availability checks
  add(
    "geocode",
    "Geocode / map location",
    planning?.geocode?.lat && planning?.geocode?.lng ? "pass" : "unknown",
    planning?.geocode?.lat && planning?.geocode?.lng
      ? `Geocode resolved (${planning.geocode.lat}, ${planning.geocode.lng}).`
      : "No geocode available – map and parcel selection may be indicative only."
  );

  add(
    "parcel",
    "Property parcel geometry",
    planning?.siteParcelPolygon ? "pass" : "unknown",
    planning?.siteParcelPolygon
      ? "A parcel polygon was identified for the subject site."
      : "Parcel polygon not available – overlays may be incomplete or point-based only."
  );

  add(
    "zoning",
    "Zoning identified",
    safeText(planning?.zoning) ? "pass" : "unknown",
    safeText(planning?.zoning)
      ? `${planning.zoning}${planning.zoningCode ? ` (${planning.zoningCode})` : ""}.`
      : "Zoning not determined from available mapping results."
  );

  add(
    "neighbourhood_plan",
    "Neighbourhood plan mapping",
    safeText(planning?.neighbourhoodPlan) ? "pass" : "unknown",
    safeText(planning?.neighbourhoodPlan)
      ? safeText(planning.neighbourhoodPlan)
      : "No neighbourhood plan identified in current lookup (confirm via Council mapping)."
  );

  // Proposal inputs
  add(
    "dimensions",
    "Outbuilding dimensions provided",
    isNum(proposal?.lengthM) && isNum(proposal?.widthM) ? "pass" : "unknown",
    isNum(proposal?.lengthM) && isNum(proposal?.widthM)
      ? `${proposal.lengthM} m × ${proposal.widthM} m.`
      : "Length and width were not fully provided."
  );

  add(
    "heights",
    "Outbuilding height provided",
    isNum(proposal?.heightRidgeM) || isNum(proposal?.heightWallM)
      ? "pass"
      : "unknown",
    isNum(proposal?.heightRidgeM) || isNum(proposal?.heightWallM)
      ? `Ridge: ${isNum(proposal.heightRidgeM) ? proposal.heightRidgeM : "-"} m; Wall: ${
          isNum(proposal.heightWallM) ? proposal.heightWallM : "-"
        } m.`
      : "Ridge and wall heights were not provided."
  );

  const sb = proposal?.setbacks || {};
  add(
    "setbacks",
    "Setbacks provided",
    sb.front != null && sb.rear != null && sb.side1 != null && sb.side2 != null
      ? "pass"
      : "unknown",
    `Front: ${sb.front ?? "-"} m; Side 1: ${sb.side1 ?? "-"} m; Side 2: ${sb.side2 ?? "-"} m; Rear: ${
      sb.rear ?? "-"
    } m.`
  );

  // Constraint triggers
  add(
    "flood_overlay",
    "Flood / overland flow overlay",
    flags.hasFlood ? "trigger" : "pass",
    flags.hasFlood
      ? "Flood/overland flow overlay appears mapped for this site."
      : "No flood/overland flow overlay detected in current mapping results (confirm with Council mapping)."
  );

  add(
    "transport_noise",
    "Transport noise corridor overlay",
    flags.hasNoise ? "trigger" : "pass",
    flags.hasNoise
      ? "Transport noise corridor overlay appears mapped for this site."
      : "No transport noise corridor detected in current mapping results (confirm if near major roads/rail)."
  );

  // Classification presence
  add(
    "classification",
    "Development classification available",
    classification?.devType && classification?.assessmentLevel
      ? "pass"
      : "unknown",
    classification?.devType && classification?.assessmentLevel
      ? `${classification.devType} – ${classification.assessmentLevel}.`
      : "Classification could not be determined from the available information."
  );

  // Overlay hints to feed Gemini and PDF
  const overlayHints = flags.overlays.map((o) => overlayHintFor(o, flags));
  const missingInputs = missingInputsFrom({ site, proposal });

  const recommendedNextSteps = [
    "Confirm zoning and overlay mapping using Brisbane City Council City Plan mapping.",
    "Confirm parcel boundaries and any easements/encumbrances from title and survey information.",
    "Confirm key proposal inputs (dimensions, height and setbacks) and assess against the applicable code benchmarks.",
  ];

  if (flags.hasFlood)
    recommendedNextSteps.unshift(
      "Undertake a flood/overland flow due diligence review and confirm overlay code requirements."
    );
  if (flags.hasNoise)
    recommendedNextSteps.unshift(
      "Check transport noise overlay implications (typically limited for non-habitable sheds)."
    );

  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    items,
    overlayHints,
    missingInputs,
    recommendedNextSteps,
  };
}
