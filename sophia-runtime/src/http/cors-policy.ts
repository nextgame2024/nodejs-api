export const SOPHIA_CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "Idempotency-Key",
  "X-Sophia-Installation-Key",
  "X-Sophia-Admin-Tenant-Id",
  "X-Correlation-ID",
] as const;

export const SOPHIA_CORS_EXPOSED_HEADERS = ['X-Correlation-ID', 'Server-Timing'] as const;
