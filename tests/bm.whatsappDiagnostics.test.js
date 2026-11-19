import { expect, test } from '@jest/globals';
import { workerFailureCode } from '../src/services/messaging/worker-diagnostics.js';

test('diagnostics classify known failures without exposing messages, SQL or arbitrary codes', () => {
  expect(workerFailureCode({ code: 'RATE_LIMITED', message: 'secret' })).toBe('rate_limited');
  expect(workerFailureCode({ code: '42P01', query: 'private SQL' })).toBe('database_table_missing');
  expect(workerFailureCode(new DOMException('private prompt', 'TimeoutError'))).toBe('generation_timeout');
  expect(workerFailureCode(new SyntaxError('private generated answer'))).toBe('invalid_answer_json');
  for (const error of [null, 'secret', { code: 'api-key-secret', message: 'private' }, { code: 'constructor' }, new Error('token')]) {
    expect(workerFailureCode(error)).toBe('operation_failed');
  }
});
