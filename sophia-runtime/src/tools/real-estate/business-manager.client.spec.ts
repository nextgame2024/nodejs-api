import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BusinessManagerClient } from "./business-manager.client.js";

const originalFetch = global.fetch;
const originalDatabaseUrl = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const originalBusinessManagerUrl = process.env.BUSINESS_MANAGER_API_URL;
const originalBusinessManagerToken = process.env.BUSINESS_MANAGER_API_TOKEN;

describe("BusinessManagerClient", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgresql://test:test@localhost/test";
    process.env.BUSINESS_MANAGER_API_URL = "https://business-manager.example/api";
    process.env.BUSINESS_MANAGER_API_TOKEN = "test-token";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreEnv("SOPHIA_RUNTIME_DATABASE_URL", originalDatabaseUrl);
    restoreEnv("BUSINESS_MANAGER_API_URL", originalBusinessManagerUrl);
    restoreEnv("BUSINESS_MANAGER_API_TOKEN", originalBusinessManagerToken);
  });

  it("sends a confirmation email after creating an inspection booking", async () => {
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        booking: {
          bookingId: "30000000-0000-4000-8000-000000000001",
          customerEmail: "jordan@example.com",
        },
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        confirmationEmail: { status: "sent", sentAt: "2026-09-07T00:00:00.000Z" },
      }));
    global.fetch = fetchMock;

    const result = await new BusinessManagerClient().bookInspection({
      customerEmail: "jordan@example.com",
    }) as { booking: { confirmationEmail: { status: string } } };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      "/inspection-bookings/30000000-0000-4000-8000-000000000001/email-confirmation",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      customerEmail: "jordan@example.com",
      confirmed: true,
    });
    expect(result.booking.confirmationEmail.status).toBe("sent");
  });

  it("keeps a confirmed booking when email delivery fails", async () => {
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        booking: {
          bookingId: "30000000-0000-4000-8000-000000000002",
          status: "confirmed",
        },
      }, 201))
      .mockResolvedValueOnce(jsonResponse({ error: "Email unavailable" }, 503));
    global.fetch = fetchMock;

    const result = await new BusinessManagerClient().bookInspection({}) as {
      booking: { status: string; confirmationEmail: { status: string } };
    };

    expect(result.booking.status).toBe("confirmed");
    expect(result.booking.confirmationEmail.status).toBe("failed");
  });

  it("resends a confirmation to the explicitly confirmed corrected email", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      confirmationEmail: {
        status: "sent",
        customerEmail: "jlcm66@gmail.com",
        resent: true,
      },
    }));
    global.fetch = fetchMock;

    await new BusinessManagerClient().resendInspectionConfirmation({
      bookingId: "30000000-0000-4000-8000-000000000001",
      customerEmail: "jlcm66@gmail.com",
      confirmed: true,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      customerEmail: "jlcm66@gmail.com",
      confirmed: true,
      forceResend: true,
    });
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
