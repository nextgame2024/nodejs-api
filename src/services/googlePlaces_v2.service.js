import axios from "axios";
import http from "http";
import https from "https";

const GOOGLE_PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

// Keep-alive agents (performance)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

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

/**
 * Small in-memory TTL cache (process-local).
 * Good enough for reducing autocomplete spikes without adding dependencies.
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

// Optional bias toward Brisbane (without hard restricting)
function getBiasParams() {
  const lat = Number(process.env.PLACES_BIAS_LAT ?? -27.4698);
  const lng = Number(process.env.PLACES_BIAS_LNG ?? 153.0251);
  const radius = Number(process.env.PLACES_BIAS_RADIUS_M ?? 60_000);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(radius)
  )
    return {};
  return {
    location: `${lat},${lng}`,
    radius: String(radius),
  };
}

export async function autocompleteAddresses({ input, sessionToken }) {
  const key = getGoogleKey();
  const trimmed = normalizeInput(input);

  if (trimmed.length < 3) return [];

  // Cache by normalized input only (sessionToken should still be forwarded, but cache should remain useful)
  const cacheKey = `au|address|${trimmed.toLowerCase()}`;
  const cached = suggestCache.get(cacheKey);
  if (cached) return cached;

  const url = `${GOOGLE_PLACES_BASE}/autocomplete/json`;
  const { data } = await axios.get(url, {
    params: {
      input: trimmed,
      key,
      components: "country:au",
      region: "au",
      language: "en",
      types: "address",
      // Bias
      ...getBiasParams(),
      // Session token recommended by Google Places billing model
      ...(sessionToken ? { sessiontoken: sessionToken } : {}),
    },
    timeout: 8000,
    httpAgent,
    httpsAgent,
  });

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(
      `Places autocomplete failed: ${data.status} ${data.error_message || ""}`.trim()
    );
  }

  const results = (data.predictions || []).slice(0, 8).map((p) => ({
    description: p.description,
    placeId: p.place_id,
  }));

  suggestCache.set(cacheKey, results);
  return results;
}

export async function getPlaceDetails({ placeId, sessionToken }) {
  const key = getGoogleKey();
  const pid = String(placeId || "").trim();
  if (!pid) throw new Error("Missing placeId");

  const cacheKey = `details|${pid}`;
  const cached = detailsCache.get(cacheKey);
  if (cached) return cached;

  const url = `${GOOGLE_PLACES_BASE}/details/json`;
  const { data } = await axios.get(url, {
    params: {
      place_id: pid,
      key,
      fields: "formatted_address,geometry",
      ...(sessionToken ? { sessiontoken: sessionToken } : {}),
    },
    timeout: 8000,
    httpAgent,
    httpsAgent,
  });

  if (data.status !== "OK") {
    throw new Error(
      `Places details failed: ${data.status} ${data.error_message || ""}`.trim()
    );
  }

  const r = data.result || {};
  const loc = r.geometry?.location;

  const details = {
    formattedAddress: r.formatted_address || null,
    lat: typeof loc?.lat === "number" ? loc.lat : null,
    lng: typeof loc?.lng === "number" ? loc.lng : null,
  };

  detailsCache.set(cacheKey, details);
  return details;
}
