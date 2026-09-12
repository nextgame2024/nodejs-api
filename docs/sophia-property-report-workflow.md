# Sophia property report workflow

This workflow applies only to inspection bookings for properties listed for sale. Rental bookings keep the existing immediate confirmation email flow.

## Runtime flow

1. The booking API commits the inspection and an idempotent report job in one database transaction.
2. Sophia confirms the booking immediately and does not wait for PDF generation.
3. The existing `cron/weeklyGenerator.js` process generates or reuses one Town Planner PDF at a time.
4. The email loop sends the booking confirmation with the PDF attached.
5. After three initial report failures, the confirmation is sent without the PDF and the report is retried daily. A successful daily retry triggers a follow-up email with the report.

PostgreSQL is the durable queue. Advisory locks limit this deployment to one active report generator and one active email sender. Rows are claimed with `FOR UPDATE SKIP LOCKED` and leases so work can recover after a process exits.

## Idempotency

`bm_property_report_jobs.cache_key` is unique and includes the company, property, property update timestamp, report version, and normalized report inputs. Unchanged property data reuses the same completed report.

`bm_inspection_confirmation_deliveries.booking_id` is unique. Repeated booking requests cannot create duplicate delivery rows. Email delivery is at-least-once: a process failure after the provider accepts an email but before the database commit can cause a duplicate retry.

## Worker configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PROPERTY_REPORT_WORKER_LOOP_MS` | `30000` | Report queue polling interval |
| `PROPERTY_REPORT_WORKER_LOCK_ID` | `74622032` | Global report worker lock |
| `PROPERTY_REPORT_LEASE_SECONDS` | `900` | Report processing lease |
| `PROPERTY_REPORT_MAX_INITIAL_ATTEMPTS` | `3` | Fast generation attempts |
| `PROPERTY_REPORT_RETRY_DELAY_SECONDS` | `120` | Initial exponential retry base |
| `PROPERTY_REPORT_DAILY_RETRY_SECONDS` | `86400` | Retry delay after initial failures |
| `INSPECTION_EMAIL_WORKER_LOOP_MS` | `15000` | Email queue polling interval |
| `INSPECTION_EMAIL_WORKER_LOCK_ID` | `74622033` | Global email worker lock |
| `INSPECTION_EMAIL_LEASE_SECONDS` | `300` | Email processing lease |
| `INSPECTION_EMAIL_MAX_ATTEMPTS` | `3` | Email delivery attempts |
| `INSPECTION_EMAIL_RETRY_DELAY_SECONDS` | `120` | Email exponential retry base |

Keep the advisory lock IDs distinct. Increasing the number of worker instances does not increase PDF concurrency because the report lock is global.

## Deployment

No additional paid worker is required. Deploy the API and the existing worker from the same source revision. Both initialize the queue tables on startup, and the worker continues to use `node cron/weeklyGenerator.js`.

The worker requires the same PostgreSQL, S3, Town Planner, mapping, and email configuration used by the existing services.

## Monitoring

Use these queries to inspect queue health:

```sql
SELECT status, COUNT(*)
FROM bm_property_report_jobs
GROUP BY status
ORDER BY status;

SELECT status, COUNT(*)
FROM bm_inspection_confirmation_deliveries
GROUP BY status
ORDER BY status;
```

Use these queries to investigate failures:

```sql
SELECT report_job_id, property_id, status, attempt_count,
       next_attempt_at, last_error, updated_at
FROM bm_property_report_jobs
WHERE status IN ('retry', 'daily_retry', 'failed')
ORDER BY updated_at DESC;

SELECT delivery_id, booking_id, status, attempt_count,
       next_attempt_at, last_error, updated_at
FROM bm_inspection_confirmation_deliveries
WHERE status IN ('email_retry', 'failed')
ORDER BY updated_at DESC;
```

Worker log entries use the `[PROPERTY_REPORT]` and `[INSPECTION_EMAIL]` prefixes.
