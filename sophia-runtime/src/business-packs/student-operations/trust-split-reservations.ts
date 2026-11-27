import type { PoolClient } from 'pg';

// Verification and reservation take the deposit lock first, then invoice locks in UUID order.
export async function lockSplitInvoices(db:PoolClient,tenant:string,connection:string,ids:string[]) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1||'/invoice/'||id::text,0))
    FROM unnest($2::uuid[]) AS id ORDER BY id`,[(tenant+'/'+connection).toLowerCase(),ids]);
}
