import axios from "axios";

const GOOGLE_PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

function getGoogleKey() {
  const key =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GMAPS_API_KEY ||
    "";
  if (!key)
    throw new Error("Missing GOOGLE_MAPS_API_KEY (or GOOGLE_PLACES_API_KEY)");
  return key;
}

export async function autocompleteAddresses({ input }) {
  const key = getGoogleKey();
  const trimmed = String(input || "").trim();
  if (trimmed.length < 3) return [];

  const url = `${GOOGLE_PLACES_BASE}/autocomplete/json`;
  const { data } = await axios.get(url, {
    params: {
      input: trimmed,
      key,
      // Australia-focused:
      components: "country:au",
      region: "au",
      language: "en",
      // "address" gives better results than "(regions)" for your use case
      types: "address",
    },
    timeout: 15000,
  });

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(
      `Places autocomplete failed: ${data.status} ${data.error_message || ""}`.trim()
    );
  }

  return (data.predictions || []).map((p) => ({
    description: p.description,
    placeId: p.place_id,
  }));
}

export async function getPlaceDetails({ placeId }) {
  const key = getGoogleKey();
  const pid = String(placeId || "").trim();
  if (!pid) throw new Error("Missing placeId");

  const url = `${GOOGLE_PLACES_BASE}/details/json`;
  const { data } = await axios.get(url, {
    params: {
      place_id: pid,
      key,
      fields: "formatted_address,geometry",
    },
    timeout: 15000,
  });

  if (data.status !== "OK") {
    throw new Error(
      `Places details failed: ${data.status} ${data.error_message || ""}`.trim()
    );
  }

  const r = data.result || {};
  const loc = r.geometry?.location;

  return {
    formattedAddress: r.formatted_address || null,
    lat: typeof loc?.lat === "number" ? loc.lat : null,
    lng: typeof loc?.lng === "number" ? loc.lng : null,
  };
}
