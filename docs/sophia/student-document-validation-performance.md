# Document upload and validation performance

The browser stages File references and uploads only after submission, with two concurrent uploads and individual idempotency keys. Validation stays asynchronous, with one extraction request per document and independent retries.

Both analysis worker entrypoints now start two jobs per tenant per pass. PostgreSQL serializes admission briefly using a tenant-specific transaction advisory lock and counts active leases, enforcing a maximum of two across worker instances. Provider calls run outside transactions. Deploy all worker instances together; old workers do not participate in the new admission lock. Existing leases, expiry fencing, five-attempt limit, and retry delay remain in force.

The case page polls local metadata every ten seconds while analysis is pending, for up to 180 polls per visit. It pauses requests while hidden, stops on navigation or completion, and retries temporary polling errors after thirty seconds. Completed rows update the checklist and case summary. This does not initiate provider work.

## Optional private temporary file cache

Configure these variables on the Runtime API and the analysis/shared worker:

- `STUDENT_DOCUMENT_TEMP_STORAGE_ENABLED=true`
- `STUDENT_DOCUMENT_TEMP_S3_BUCKET=<dedicated private bucket>`
- `STUDENT_DOCUMENT_TEMP_S3_REGION=<bucket region>`

Use the existing AWS SDK credential chain, with access restricted to this bucket and the `student-document-analysis/` object prefix. The API needs `s3:PutObject`, `s3:GetBucketPublicAccessBlock`, `s3:GetLifecycleConfiguration`, and `s3:GetBucketVersioning`. The worker needs `s3:GetObject` and `s3:DeleteObject`. Do not grant public access or expose object URLs to browsers.

The bucket must have all four S3 Block Public Access settings enabled, must never have had versioning enabled, and must have this enabled lifecycle rule:

```json
{"Rules":[{"ID":"expire-validation-inputs","Status":"Enabled","Filter":{"Prefix":"student-document-analysis/"},"Expiration":{"Days":1}}]}
```

The API verifies these properties before writing. Each object uses SSE-S3 encryption (`AES256`), a SHA-256 checksum, and a key containing tenant, case, upload/replacement operation ID, and content hash. File names and extracted personal details are excluded from keys. Only document types configured for analysis are cached, after provider upload succeeds and before the document/job transaction commits. The same flow covers replacements. Storage calls have bounded timeouts; no storage request holds a database transaction open.

The worker resolves the reference from existing durable upload/replacement records under tenant RLS. It checks the current source hash, reads at most 10 MB, rejects cache copies older than 24 hours, and verifies bytes against the job hash before extraction. It removes the cache object after successful or terminal validation, retains it for retryable failures, and relies on lifecycle expiration for abandoned uploads, crashes, or failed deletion. S3 lifecycle deletion is asynchronous; the application stops using cached copies at 24 hours. Use an unversioned bucket so deletion does not retain hidden versions.

If caching is disabled, missing, expired, or unavailable, validation downloads the stored original as before. Failed cache writes emit the safe `document_analysis_temp_cache_unavailable` warning at most once per minute per service instance. A cache hit avoids one Xero content request; it adds a bounded S3 write during upload. Actual elapsed-time improvement depends on document sizes and provider latency and has not been benchmarked against production.

## Verification and rollout

No database migration is needed. Deploy backend API, workers, and frontend. Concurrency and polling improvements apply with the existing analysis configuration. Enable the cache only after provisioning and verifying the bucket and IAM permissions on both API and worker. No cloud resources or live provider mutations were performed by this change.

Local verification: 43 focused backend tests, six PostgreSQL integration tests (including independent queue instances competing for two slots), 78 case-page browser tests, and backend/frontend TypeScript checks passed. Storage/provider calls were mocked; PostgreSQL used the real tenant role and schema in an isolated local instance.
