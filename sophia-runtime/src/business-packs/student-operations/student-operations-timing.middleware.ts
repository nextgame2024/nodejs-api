import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  elapsedMs, logStudentOperationsTiming, studentOperationsTimingContext,
  studentOperationsTimingEnabled, type StudentOperationsTimingRecord,
} from './student-operations-timing.js';

type TimingRequest = IncomingMessage & {
  originalUrl?: string;
  studentOperationsCorrelationId?: string;
};

export function studentOperationsTimingMiddleware(allowedOrigins: readonly string[]) {
  return (request: TimingRequest, response: ServerResponse, next: () => void): void => {
    const pathname = (request.originalUrl ?? request.url ?? '').split('?', 1)[0];
    if (!studentOperationsTimingEnabled() || !pathname.startsWith('/api/business-packs/student-operations/v1/')) {
      next(); return;
    }
    const input = request.headers['x-correlation-id'];
    const value = Array.isArray(input) ? input[0] : input;
    const correlationId = value && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : randomUUID();
    request.studentOperationsCorrelationId = correlationId;
    response.setHeader('X-Correlation-ID', correlationId);
    const origin = request.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.includes(origin)) response.setHeader('Timing-Allow-Origin', origin);
    const startedAt = performance.now();
    const records: StudentOperationsTimingRecord[] = [];
    const originalEnd = response.end;
    response.end = function (this: ServerResponse, ...args: unknown[]) {
      // Express JSON responses call end before headers are sent. Streamed
      // content still gets a finish log, without attempting to alter sent headers.
      try {
        if (!this.headersSent) this.setHeader('Server-Timing', serverTiming(records, elapsedMs(startedAt)));
      } catch { /* Diagnostics cannot change the response. */ }
      return Reflect.apply(originalEnd, this, args);
    } as typeof response.end;
    response.once('finish', () => {
      logStudentOperationsTiming('http-request', correlationId, response.statusCode < 400 ? 'ok' : 'error', {
        totalMs: elapsedMs(startedAt), statusCode: response.statusCode,
      }, classifyStudentOperationsRequest(pathname));
    });
    studentOperationsTimingContext.run(records, next);
  };
}

export function classifyStudentOperationsRequest(pathname: string): string {
  if (/\/student-register$/.test(pathname)) return 'students';
  if (/\/student-invoices$/.test(pathname)) return 'payments';
  if (/\/payment-tracks$/.test(pathname)) return 'payment-tracks';
  if (/\/student-sync$/.test(pathname)) return 'sync-status';
  if (/\/integrations\/xero$/.test(pathname)) return 'xero-status';
  if (/\/workspace$/.test(pathname)) return 'workspace';
  if (/\/documents$/.test(pathname)) return 'case-documents';
  return 'workspace-other';
}

function serverTiming(records: StudentOperationsTimingRecord[], totalMs: number): string {
  const metrics = new Map<string, number>([['app', totalMs]]);
  const aliases: Record<string, string> = { 'workspace-guard': 'guard', 'workspace-resolution': 'workspace',
    'student-register': 'register', 'xero-status': 'xero_status', 'xero-invoices': 'invoices', 'xero-payment-tracks': 'tracks' };
  const fields: Record<string, string> = { totalMs: 'total', identityMs: 'identity', entitlementMs: 'access',
    dbPoolAcquireMs: 'pool', dbSetupMs: 'setup', dbWorkMs: 'db_work', dbCommitMs: 'commit',
    registerQueryMs: 'query', invoiceQueryMs: 'query', caseLinksMs: 'cases', optionsMs: 'options' };
  for (const record of records) {
    const prefix = aliases[record.phase];
    if (!prefix) continue;
    for (const [field, alias] of Object.entries(fields)) {
      const value = record.durations[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics.set(`${prefix}_${alias}`, value);
    }
  }
  return [...metrics].map(([name, value]) => `${name};dur=${value.toFixed(2)}`).join(', ');
}
