/**
 * Very simple rule-based classifier for now.
 * Later we can refine and/or add Gemini for richer explanations.
 *
 * Input shape:
 *  - site: { ... }
 *  - proposal: { lengthM, widthM, heightRidgeM, heightWallM, purpose, ... }
 *  - planning: { zoning, overlays, hasTransportNoiseCorridor, ... }
 */
export function classifyDevelopment(options) {
  const site = options.site || {};
  const proposal = options.proposal || {};
  const planning = options.planning || {};

  const zoningName = (planning.zoning || "").toString();
  const zoneLower = zoningName.toLowerCase();

  const overlays = Array.isArray(planning.overlays) ? planning.overlays : [];
  const overlayNames = overlays
    .map((o) => ((o && o.name) || "").toString().toLowerCase())
    .filter(Boolean);

  // --- 1) Heuristic: development type ---

  let devType = "Unknown";
  let devTypeReason = "";

  // If there's some explicit flag in future, we can check that here.
  // For now, we treat this pre-assessment flow as mainly "domestic outbuilding"/shed.
  const hasDimensions =
    typeof proposal.lengthM === "number" && typeof proposal.widthM === "number";

  const isResidentialZone =
    zoneLower.indexOf("low density residential") !== -1 ||
    zoneLower.indexOf("ldr") !== -1;

  if (hasDimensions && isResidentialZone) {
    devType = "BuildingWork";
    devTypeReason =
      "The proposal appears to be a domestic outbuilding / building work in a residential zone.";
  } else if (
    proposal &&
    (proposal.newUse || proposal.changeOfUse || proposal.useType === "MCU")
  ) {
    devType = "MCU";
    devTypeReason =
      "The proposal suggests a change of use (Material Change of Use).";
  } else if (proposal && proposal.subdivisionLots) {
    devType = "RoL";
    devTypeReason =
      "The proposal refers to new lots, so it likely involves Reconfiguring a Lot.";
  } else {
    devType = "Unknown";
    devTypeReason =
      "Insufficient information to clearly identify the development type.";
  }

  // --- 2) Heuristic: assessment level ---

  let assessmentLevel = "unknown";
  let levelReason = "";

  // Rough size/height for outbuildings
  let area = null;
  if (hasDimensions) {
    area = proposal.lengthM * proposal.widthM;
  }

  const hasFloodOverlay =
    overlayNames.some((n) => n.indexOf("flood") !== -1) ||
    overlayNames.some((n) => n.indexOf("overland flow") !== -1);

  // Very approximate rules, not legal advice:
  if (devType === "BuildingWork" && isResidentialZone) {
    // Very small shed in LDR might be accepted or accepted subject to requirements
    if (area !== null && area <= 10 && !hasFloodOverlay) {
      assessmentLevel = "accepted_or_low";
      levelReason =
        "Small domestic structure in Low Density Residential zone with limited overlays; " +
        "it may be accepted development or accepted subject to requirements, depending on detailed City Plan rules.";
    } else {
      assessmentLevel = "code";
      levelReason =
        "Domestic outbuilding / building work in Low Density Residential zone is commonly code assessable, " +
        "subject to specific provisions in the applicable codes and overlays.";
    }
  } else if (devType === "MCU" || devType === "RoL") {
    assessmentLevel = "code_or_impact";
    levelReason =
      "Material Change of Use or Reconfiguring a Lot can be code or impact assessable depending on the specific use, scale and zone.";
  } else {
    assessmentLevel = "unknown";
    levelReason =
      "Cannot reliably determine the assessment level from the available information.";
  }

  // Note overlays add complexity but we are not fully modelling their effect here.
  if (hasFloodOverlay) {
    levelReason +=
      " Flood overlays are present, so additional technical reports and/or more complex assessment may be required.";
  }

  const reasoning =
    devTypeReason + (devTypeReason && levelReason ? " " : "") + levelReason;

  return {
    devType: devType,
    assessmentLevel: assessmentLevel,
    reasoning: reasoning,
  };
}
