import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";

@Injectable()
export class BusinessManagerClient {
  searchProperties(input: Record<string, unknown>) {
    return this.get("/bm/real-estate/properties", input);
  }
  getProperty(propertyId: string) {
    return this.get(`/bm/real-estate/properties/${encodeURIComponent(propertyId)}`);
  }
  getInspectionSlots(propertyId: string, input: Record<string, unknown>) {
    return this.get(`/bm/real-estate/properties/${encodeURIComponent(propertyId)}/inspection-slots`, input);
  }
  searchKnowledge(input: Record<string, unknown>) {
    return this.get("/bm/real-estate/knowledge", input);
  }
  bookInspection(input: Record<string, unknown>) {
    return this.request("/bm/real-estate/inspection-bookings", {
      method: "POST",
      body: JSON.stringify({ booking: input }),
    });
  }

  private get(path: string, query: Record<string, unknown> = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const suffix = params.size ? `?${params}` : "";
    return this.request(`${path}${suffix}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const config = runtimeConfig().businessManager;
    if (!config.apiToken) throw new Error("Business Manager integration is not configured.");
    const response = await fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(payload.error || `Business Manager request failed (${response.status}).`);
    return payload;
  }
}
