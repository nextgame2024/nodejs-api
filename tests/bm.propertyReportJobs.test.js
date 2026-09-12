import { describe, expect, it, jest } from "@jest/globals";

import {
  buildPropertyReportDescriptor,
  enqueueSaleReportDelivery,
} from "../src/models/bm.propertyReportJobs.model.js";

const property = {
  companyId: "10000000-0000-4000-8000-000000000001",
  propertyId: "20000000-0000-4000-8000-000000000001",
  propertyAddress: "12 Smith Street",
  propertySuburb: "West End",
  propertyCity: "Brisbane",
  propertyState: "QLD",
  propertyPostcode: "4101",
  propertyLatitude: -27.4815,
  propertyLongitude: 153.0124,
  propertyUpdatedAt: "2026-09-12T00:00:00.000Z",
};

describe("property report job persistence", () => {
  it("uses property and report versions to build a stable cache key", () => {
    const first = buildPropertyReportDescriptor(property, "report-v1");
    const same = buildPropertyReportDescriptor({ ...property }, "report-v1");
    const updated = buildPropertyReportDescriptor({
      ...property,
      propertyUpdatedAt: "2026-09-13T00:00:00.000Z",
    }, "report-v1");

    expect(first.cacheKey).toBe(same.cacheKey);
    expect(updated.cacheKey).not.toBe(first.cacheKey);
    expect(first.reportInputs).toEqual(expect.objectContaining({
      addressLabel: "12 Smith Street, West End, Brisbane, QLD, 4101",
      lat: -27.4815,
      lng: 153.0124,
    }));
  });

  it("queues email delivery immediately when a cached report is ready", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        report_job_id: "30000000-0000-4000-8000-000000000001",
        status: "ready",
        pdf_key: "reports/property.pdf",
      }] })
      .mockResolvedValueOnce({ rows: [{
        delivery_id: "40000000-0000-4000-8000-000000000001",
        status: "email_queued",
      }] });

    const result = await enqueueSaleReportDelivery({ query }, {
      companyId: property.companyId,
      bookingId: "50000000-0000-4000-8000-000000000001",
      property,
      reportVersion: "report-v1",
    });

    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (cache_key)");
    expect(query.mock.calls[1][0]).toContain("ON CONFLICT (booking_id)");
    expect(query.mock.calls[1][1][3]).toBe("email_queued");
    expect(result).toEqual(expect.objectContaining({
      reportStatus: "ready",
      deliveryStatus: "email_queued",
    }));
  });
});
