import crypto from "crypto";

export function buildPropertyReportDescriptor(property, reportVersion) {
  const addressLabel = [
    property.propertyAddress,
    property.propertySuburb,
    property.propertyCity,
    property.propertyState,
    property.propertyPostcode,
  ].filter(Boolean).join(", ");
  const updatedAt = new Date(property.propertyUpdatedAt);
  const propertyVersion = Number.isFinite(updatedAt.getTime())
    ? updatedAt.toISOString()
    : "unknown";
  const coordinate = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const reportInputs = {
    propertyId: property.propertyId,
    addressLabel,
    placeId: null,
    lat: coordinate(property.propertyLatitude),
    lng: coordinate(property.propertyLongitude),
    lotPlan: null,
  };
  const cacheKey = crypto.createHash("sha256").update(JSON.stringify({
    companyId: property.companyId,
    propertyId: property.propertyId,
    propertyVersion,
    reportVersion,
    reportInputs,
  })).digest("hex");

  return { cacheKey, propertyVersion, reportInputs };
}

export async function enqueueSaleReportDelivery(client, input) {
  const descriptor = buildPropertyReportDescriptor(input.property, input.reportVersion);
  const reportResult = await client.query(
    `INSERT INTO bm_property_report_jobs (
       company_id, property_id, cache_key, report_version, property_version, report_inputs
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (cache_key) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [input.companyId, input.property.propertyId, descriptor.cacheKey,
      input.reportVersion, descriptor.propertyVersion, descriptor.reportInputs],
  );
  const report = reportResult.rows[0];
  const ready = report.status === "ready" && report.pdf_key;
  const exhausted = !!report.initial_attempts_exhausted_at && !ready;
  const status = ready ? "email_queued" : exhausted ? "fallback_queued" : "waiting_report";
  const deliveryResult = await client.query(
    `INSERT INTO bm_inspection_confirmation_deliveries (
       company_id, booking_id, report_job_id, status, fallback_without_report
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (booking_id) DO UPDATE
       SET report_job_id = EXCLUDED.report_job_id, updated_at = now()
     RETURNING *`,
    [input.companyId, input.bookingId, report.report_job_id, status, exhausted],
  );
  return {
    reportJobId: report.report_job_id,
    reportStatus: report.status,
    deliveryId: deliveryResult.rows[0].delivery_id,
    deliveryStatus: deliveryResult.rows[0].status,
  };
}
