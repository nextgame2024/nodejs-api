import { BadGatewayException } from '@nestjs/common';
import { runtimeConfig } from '../../config/runtime-config.js';
import type { DatabaseService } from '../../database/database.service.js';

export type XeroRequestPolicy = {
  beforeRequest(): Promise<void>;
  observe(response: Response): Promise<void>;
};

function remaining(headers: Headers, name: string): number | null {
  const raw = headers.get(name)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// Only bounded numeric metadata is retained. Never retain upstream bodies,
// URLs, tokens, organisation names or arbitrary provider header values.
export function xeroRateObservation(response: Response) {
  const day = remaining(response.headers, 'x-daylimit-remaining');
  const minute = remaining(response.headers, 'x-minlimit-remaining');
  const appMinute = remaining(response.headers, 'x-appminlimit-remaining');
  const rawProblem = response.headers.get('x-rate-limit-problem')?.toLowerCase();
  const problem = ['day', 'minute', 'app', 'concurrent'].includes(rawProblem ?? '') ? rawProblem! : null;
  const retry = remaining(response.headers, 'retry-after');
  // Unknown 429s fail conservatively for a day, not a tight retry loop. The
  // actual app tier/rolling allowance is not inferred from a Brisbane date.
  const fallback = problem === 'minute' || problem === 'app' || problem === 'concurrent' ? 60 : 86400;
  const retryAfterSeconds = response.status === 429
    ? Math.max(1, Math.min(retry ?? fallback, 604800)) : null;
  const exhaustedDelay = Math.max(day === 0 ? 86400 : 0, minute === 0 || appMinute === 0 ? 60 : 0);
  return { day, minute, appMinute, problem, retryAfterSeconds,
    blockSeconds: response.status === 429 ? retryAfterSeconds! : response.ok ? exhaustedDelay : 0 };
}

export class XeroSharedBackoff {
  constructor(private readonly database: DatabaseService) {}

  policy(customerId: string, connectionId: string): XeroRequestPolicy {
    const table = `${runtimeConfig().schema}.xero_connection_rate_limits`;
    return {
      beforeRequest: async () => {
        const result = await this.database.tenantReadTransaction(customerId, db => db.query<{seconds: number}>(
          `SELECT ceil(extract(epoch FROM blocked_until-now()))::int AS seconds
           FROM ${table} WHERE customer_id=$1 AND xero_connection_id=$2 AND blocked_until>now()`,
          [customerId, connectionId]));
        if (result.rows[0]) throw new BadGatewayException({
          message: 'Xero is temporarily rate limited. Try again later.',
          errorCode: 'xero_rate_limited', providerStatus: 429,
          retryAfterSeconds: result.rows[0].seconds,
        });
      },
      observe: async response => {
        const value = xeroRateObservation(response);
        if (value.day === null && value.minute === null && value.appMinute === null && response.status !== 429) return;
        await this.database.tenantTransaction(customerId, db => db.query(
          `INSERT INTO ${table}(customer_id,xero_connection_id,day_remaining,minute_remaining,app_minute_remaining,
             limit_problem,blocked_until,observed_at)
           VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::int>0 THEN now()+($7 * interval '1 second') END,now())
           ON CONFLICT(customer_id,xero_connection_id) DO UPDATE SET
             day_remaining=excluded.day_remaining,minute_remaining=excluded.minute_remaining,
             app_minute_remaining=excluded.app_minute_remaining,limit_problem=excluded.limit_problem,
             blocked_until=greatest(xero_connection_rate_limits.blocked_until,excluded.blocked_until),observed_at=now()`,
          [customerId,connectionId,value.day,value.minute,value.appMinute,value.problem,value.blockSeconds]));
      },
    };
  }
}
