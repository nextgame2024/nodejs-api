# Lead form publishing and notification emails

Deploy frontend and backend together after applying migrations 132 and 133 with the configured owner migration runner (`npm run build` then `npm run migrate` in `sophia-runtime`, using the deployment's runtime database configuration). The current 503 indicates that the publication table is absent. Deploying frontend code alone cannot resolve it. Do not run these migrations against production without authorization.

Edit each form and supply its required comma-separated Emails field (maximum 10 recipients). Save, then use the globe Publish action. The published URL uses the frontend origin and `/forms/:token`; the production host must serve the SPA at that path. Localhost links are development-only. Republishing updates the snapshot at the same URL. Recipient addresses are not included in the public response.

Send atomically stores the response, lead and optional appointment, and queues one notification per recipient. Bookings appear in Scheduling → Lead appointments for the form's company/advisor. Request retries reuse the receipt and do not create another appointment or notification. Cancel clears the unsent response after confirmation and does not create data.

The API starts the email workflow automatically and polls every 15 seconds. It reads active tenant IDs from the registry in batches of 50, then processes each delivery with the non-BYPASSRLS runtime role and tenant RLS. No cron configuration is required for normal API deployments. As an alternative for deployments without the API background loop, schedule `node cron/leadFormEmailCron.js` every minute from the backend directory. Configure `FORM_EMAIL_TENANT_IDS` with the comma-separated runtime customer UUIDs for the companies served by the worker. It uses tenant-scoped `sophia_runtime_app` transactions; each cycle handles up to 25 pending deliveries per configured tenant. Concurrent workers use SKIP LOCKED.

Use the existing `EMAIL_PROVIDER=ses` with `SES_FROM_EMAIL` (or the existing `SES_FROM`) and AWS credentials/region (`AWS_REGION` or `SES_REGION`), or `EMAIL_PROVIDER=smtp` with SMTP_HOST, SMTP_PORT, SMTP_FROM_EMAIL, SMTP_USER, SMTP_PASS and SMTP_SECURE. `EMAIL_PROVIDER=log` is development-only: it acknowledges deliveries without contacting a provider or logging answers.

Delivery retries every five minutes, up to five attempts. Monitor unsent rows with attempts >= 5; after correcting provider configuration, an operator can requeue selected failed rows under the normal tenant boundary. Delivery is at-least-once: a process crash after provider acceptance but before committing sent_at can cause a repeated email. Customer submission remains successful even when email delivery needs a retry.

Migrations 132 and 133 were applied to the configured database with user approval on 2026-11-15. No live test publications or test emails were sent. Deploy the API changes to activate its automatic email workflow.
