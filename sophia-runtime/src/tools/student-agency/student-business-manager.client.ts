import { runtimeConfig } from "../../config/runtime-config.js";

/**
 * Legacy student-agency transport retained outside the active Sophia runtime
 * dependency graph. A future product module may replace or adopt it explicitly.
 */
export class StudentBusinessManagerClient {
  getStudentConsultationSlots() {
    return this.get("/bm/student-agency/consultation-slots");
  }

  reviewStudentConsultation(input: Record<string, unknown>) {
    return this.request("/bm/student-agency/consultation-review", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  bookStudentConsultation(input: Record<string, unknown>) {
    return this.request("/bm/student-agency/consultation-bookings", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getStudentConsultationBooking(bookingId: string) {
    return this.get(`/bm/student-agency/consultation-bookings/${encodeURIComponent(bookingId)}`);
  }

  reviewStudentConsultationEmail(input: Record<string, unknown>) {
    return this.request(
      `/bm/student-agency/consultation-bookings/${encodeURIComponent(String(input["bookingId"]))}/review-email`,
      { method: "POST", body: JSON.stringify({ customerEmail: input["customerEmail"] }) },
    );
  }

  resendStudentConsultationEmail(input: Record<string, unknown>) {
    return this.request(
      `/bm/student-agency/consultation-bookings/${encodeURIComponent(String(input["bookingId"]))}/email`,
      {
        method: "POST",
        body: JSON.stringify({
          customerEmail: input["customerEmail"],
          confirmed: input["confirmed"],
        }),
      },
    );
  }

  compareStudentRules(input: Record<string, unknown>) {
    return this.get("/bm/student-agency/compare", input);
  }

  verifyStudentRules(input: Record<string, unknown>) {
    return this.get("/bm/student-agency/verify", input);
  }

  searchStudentAgencyKnowledge(input: Record<string, unknown>) {
    return this.get("/bm/student-agency/knowledge", input);
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
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(payload.error || `Business Manager request failed (${response.status}).`);
    return payload;
  }
}
