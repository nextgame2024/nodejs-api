/**
 * Simple, conservative classification helper.
 *
 * It is NOT legal advice – just a heuristic to give the user a
 * “likely development type / assessment level” label.
 */
export function classifyDevelopment({
  site = {},
  proposal = {},
  planning = {},
} = {}) {
  const zoningCode = (planning.zoningCode || "").toUpperCase().trim();
  const zoningName = (planning.zoning || "").toLowerCase();

  const purposeText = (
    (proposal.use || proposal.purpose || "") + ""
  ).toLowerCase();

  const hasDims = !!(proposal.lengthM && proposal.widthM);
  const maxHeight = Math.max(
    Number(proposal.heightRidgeM || 0),
    Number(proposal.heightWallM || 0)
  );

  const unknown = {
    devType: "Unknown",
    assessmentLevel: "unknown",
    reasoning:
      "Insufficient information to clearly identify the development type. " +
      "Cannot reliably determine the assessment level from the available information.",
  };

  // If we have literally no zoning info, stay conservative.
  if (!zoningCode && !zoningName) {
    return unknown;
  }

  // Very simple “is this clearly a residential zone?” test.
  const isResidentialZone =
    /^LDR|^LMR|^HDR|^GRZ|^RES/.test(zoningCode) ||
    zoningName.includes("residential");

  // Does this look like a domestic outbuilding / shed?
  const looksLikeOutbuilding =
    purposeText.includes("shed") ||
    purposeText.includes("outbuilding") ||
    purposeText.includes("garage") ||
    purposeText.includes("carport") ||
    (isResidentialZone && hasDims && maxHeight > 0);

  // 1) Domestic outbuilding in a residential zone
  if (looksLikeOutbuilding && isResidentialZone) {
    return {
      devType: "Building work – domestic outbuilding",
      assessmentLevel: "accepted or code assessable",
      reasoning:
        "The proposal appears to be a domestic outbuilding (e.g. shed/garage) " +
        "on land in a residential zone. Under Brisbane City Plan, domestic " +
        "outbuildings associated with a dwelling house are typically accepted " +
        "or code assessable building work, provided height, site cover and " +
        "setbacks comply with the Dwelling house code and any relevant overlay codes. " +
        "A full town planning review of the proposal against the City Plan is still recommended.",
    };
  }

  // 2) Generic residential building work where we can’t tell exactly what it is
  if (isResidentialZone && hasDims) {
    return {
      devType: "Building work – residential",
      assessmentLevel: "likely code assessable",
      reasoning:
        "The site appears to be in a residential zone and the proposal involves " +
        "new building work with defined dimensions. In many cases this will be " +
        "code assessable against the Dwelling house code and relevant overlay codes. " +
        "Further review of the full plans and City Plan tables is recommended.",
    };
  }

  // 3) Anything else – stay conservative for now
  return unknown;
}
