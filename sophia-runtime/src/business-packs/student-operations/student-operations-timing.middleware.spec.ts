import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { studentOperationsTimingMiddleware } from './student-operations-timing.middleware.js';
import { logStudentOperationsTiming } from './student-operations-timing.js';

const originalFlag = process.env.SOPHIA_STUDENT_OPERATIONS_TIMING;
afterEach(() => {
  if (originalFlag === undefined) delete process.env.SOPHIA_STUDENT_OPERATIONS_TIMING;
  else process.env.SOPHIA_STUDENT_OPERATIONS_TIMING = originalFlag;
  jest.restoreAllMocks();
});

function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, headersSent: false, headers: new Map<string, string>(),
    setHeader(name: string, value: string) { this.headers.set(name, value); },
    end(body: string) { this.emit('finish'); return body; },
  });
}

describe('Student Operations request timings', () => {
  it('leaves responses alone while disabled or outside Student Operations', () => {
    const middleware = studentOperationsTimingMiddleware([]);
    const next = jest.fn();
    const res = response(); const end = res.end;
    delete process.env.SOPHIA_STUDENT_OPERATIONS_TIMING;
    middleware({ url: '/api/business-packs/student-operations/v1/workspace', headers: {} } as never, res as never, next);
    process.env.SOPHIA_STUDENT_OPERATIONS_TIMING = '1';
    middleware({ url: '/api/runtime/healthz', headers: {} } as never, res as never, next);
    expect(res.end).toBe(end); expect(res.headers.size).toBe(0); expect(next).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent requests isolated and preserves response content', async () => {
    process.env.SOPHIA_STUDENT_OPERATIONS_TIMING = '1';
    const log = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
    const middleware = studentOperationsTimingMiddleware(['https://sophiaai.com.au']);
    const results = await Promise.all([17, 93].map((duration, i) => new Promise<ReturnType<typeof response>>(resolve => {
      const res = response();
      const req = { url: '/api/business-packs/student-operations/v1/workspace/student-register?q=private-name',
        headers: { authorization: 'Token private-token', origin: 'https://sophiaai.com.au', 'x-correlation-id': `trace-${i}` } };
      middleware(req as never, res as never, () => {
        setTimeout(() => {
          logStudentOperationsTiming('workspace-guard', `trace-${i}`, 'ok', { totalMs: duration, identityMs: duration - 1 });
          logStudentOperationsTiming('student-register', `trace-${i}`, 'ok', { registerQueryMs: duration, dbPoolAcquireMs: 2 });
          expect(res.end('response-body')).toBe('response-body'); resolve(res);
        }, i === 0 ? 5 : 0);
      });
    })));
    expect(results[0].headers.get('Server-Timing')).toContain('register_query;dur=17.00');
    expect(results[0].headers.get('Server-Timing')).not.toContain('93.00');
    expect(results[1].headers.get('Server-Timing')).toContain('register_query;dur=93.00');
    expect(results[0].headers.get('Timing-Allow-Origin')).toBe('https://sophiaai.com.au');
    const logs = log.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(logs.filter(item => item.phase === 'http-request')).toEqual(expect.arrayContaining([
      expect.objectContaining({ correlationId: 'trace-0', operation: 'students', statusCode: 200 }),
      expect.objectContaining({ correlationId: 'trace-1', operation: 'students', statusCode: 200 }),
    ]));
    expect(JSON.stringify(logs)).not.toMatch(/private-name|private-token|response-body/);
  });

  it('reports failures without reflecting untrusted origins or invalid correlation headers', () => {
    process.env.SOPHIA_STUDENT_OPERATIONS_TIMING = '1';
    const log = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
    const res = response(); res.statusCode = 403;
    studentOperationsTimingMiddleware(['https://sophiaai.com.au'])({
      url: '/api/business-packs/student-operations/v1/workspace/cases/private-id/documents',
      headers: { origin: 'https://untrusted.invalid', 'x-correlation-id': 'bad\r\nheader' },
    } as never, res as never, () => res.end('denied'));
    expect(res.headers.has('Timing-Allow-Origin')).toBe(false);
    expect(res.headers.get('X-Correlation-ID')).toMatch(/^[a-f0-9-]{36}$/);
    const entry = JSON.parse(String(log.mock.calls[0][0]));
    expect(entry).toMatchObject({ phase: 'http-request', operation: 'case-documents', outcome: 'error', statusCode: 403 });
    expect(JSON.stringify(entry)).not.toContain('private-id');
  });
});
