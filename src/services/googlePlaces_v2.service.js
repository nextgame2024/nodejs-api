import axios from "axios";
import http from "http";
import https from "https";

// Places API (New) base
const PLACES_V1_BASE = "https://places.googleapis.com/v1";

// Keep-alive agents (performance)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function getGoogleKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY || "";
  console.log(
    "Maps key fingerprint:",
    key ? `${key.slice(0, 4)}...${key.slice(-4)}` : "MISSING"
  );
  if (!key) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY (or GOOGLE_PLACES_API_KEY)");
  }
  return key;
}

/**
 * Small in-memory TTL cache (process-local).
 */
class TtlCache {
  constructor({ ttlMs, max = 500 }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map(); // key -> { exp, val }
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) {
      this.map.delete(key);
      return null;
    }
    // refresh recency (basic LRU behavior)
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.val;
  }

  set(key, val) {
    if (this.map.size >= this.max) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey) this.map.delete(oldestKey);
    }
    this.map.set(key, { exp: Date.now() + this.ttlMs, val });
  }
}

const suggestCache = new TtlCache({ ttlMs: 60_000, max: 800 }); // 60s
const detailsCache = new TtlCache({ ttlMs: 6 * 60 * 60_000, max: 2000 }); // 6h

function normalizeInput(input) {
  return String(input || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Optional bias toward Brisbane (without hard restricting).
 * Places API (New) uses "locationBias" in the request body.
 */
function getLocationBias() {
  const lat = Number(process.env.PLACES_BIAS_LAT ?? -27.4698);
  const lng = Number(process.env.PLACES_BIAS_LNG ?? 153.0251);
  const radius = Number(process.env.PLACES_BIAS_RADIUS_M ?? 60_000);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return null;
  }

  return {
    circle: {
      center: { latitude: lat, longitude: lng },
      radius,
    },
  };
}

/**
 * Autocomplete addresses using Places API (New)
 * POST /v1/places:autocomplete
 *
 * Returns: [{ description, placeId }]
 */
export async function autocompleteAddresses({ input, sessionToken }) {
  const key = getGoogleKey();
  const trimmed = normalizeInput(input);

  if (trimmed.length < 3) return [];

  // Cache by normalized input only
  const cacheKey = `au|address|${trimmed.toLowerCase()}`;
  const cached = suggestCache.get(cacheKey);
  if (cached) return cached;

  const url = `${PLACES_V1_BASE}/places:autocomplete`;

  const body = {
    input: trimmed,
    languageCode: "en",
    regionCode: "AU",
    // If you want to limit to address-like results, you can uncomment:
    // includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
    ...(sessionToken ? { sessionToken } : {}),
  };

  const locationBias = getLocationBias();
  if (locationBias) body.locationBias = locationBias;

  try {
    const { data } = await axios.post(url, body, {
      headers: {
        "X-Goog-Api-Key": key,
        // Only request what we need for suggestions:
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.text",
      },
      timeout: 8000,
      httpAgent,
      httpsAgent,
    });

    const results = (data?.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .slice(0, 8)
      .map((p) => ({
        description: p.text?.text || "",
        placeId: p.placeId,
      }))
      .filter((x) => x.placeId && x.description);

    suggestCache.set(cacheKey, results);
    return results;
  } catch (err) {
    const status = err?.response?.status;
    // Surface Google’s response in logs for debugging, but throw clean error upward
    const upstream = err?.response?.data;
    console.error(
      "Places upstream-autocompleteAddresses:",
      JSON.stringify(err?.response?.data, null, 2)
    );
    const msg =
      upstream?.error?.message ||
      upstream?.message ||
      err?.message ||
      "Unknown error";
    throw new Error(`Places autocomplete failed: ${msg}`);
  }
}

/**
 * Place details using Places API (New)
 * GET /v1/places/{placeId}
 *
 * Returns:
 * { formattedAddress: string|null, lat: number|null, lng: number|null }
 */
export async function getPlaceDetails({ placeId, sessionToken }) {
  const key = getGoogleKey();
  const pid = String(placeId || "").trim();
  if (!pid) throw new Error("Missing placeId");

  const cacheKey = `details|${pid}`;
  const cached = detailsCache.get(cacheKey);
  if (cached) return cached;

  const url = `${PLACES_V1_BASE}/places/${encodeURIComponent(pid)}`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        "X-Goog-Api-Key": key,
        // Only request what we need:
        "X-Goog-FieldMask": "formattedAddress,location",
      },
      params: sessionToken ? { sessionToken } : undefined,
      timeout: 8000,
      httpAgent,
      httpsAgent,
    });

    const loc = data?.location;

    const details = {
      formattedAddress: data?.formattedAddress || null,
      lat: typeof loc?.latitude === "number" ? loc.latitude : null,
      lng: typeof loc?.longitude === "number" ? loc.longitude : null,
    };

    detailsCache.set(cacheKey, details);
    return details;
  } catch (err) {
    const status = err?.response?.status;
    const upstream = err?.response?.data;
    console.error(
      "Places upstream-getPlaceDetails:",
      JSON.stringify(err?.response?.data, null, 2)
    );
    const msg =
      upstream?.error?.message ||
      upstream?.message ||
      err?.message ||
      "Unknown error";
    throw new Error(`Places details failed: ${msg}`);
  }
}
