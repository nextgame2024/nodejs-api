import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

export type ActionReviewMode = string;
export type ActionReviewContext = { sessionId: string; customerId: string };
export type CreatedActionReview = { reviewId: string; commandId: string; expiresAt: string };
export type CurrentActionReview = CreatedActionReview & {
  actionType: ActionReviewMode;
  status: "reviewed" | "confirmed";
  payload: Record<string, unknown>;
};

export interface ActionReviewStore {
  create(context: ActionReviewContext, mode: ActionReviewMode, payload: Record<string, unknown>): Promise<CreatedActionReview>;
  current(context: ActionReviewContext): Promise<CurrentActionReview | null>;
  confirm(context: ActionReviewContext, reviewId: string): Promise<void>;
  cancel(context: ActionReviewContext, reviewId: string): Promise<void>;
  consume(context: ActionReviewContext, reviewId: string, mode: ActionReviewMode, payload: Record<string, unknown>): Promise<string>;
  clear(context: ActionReviewContext): Promise<void>;
}

@Injectable()
export class PostgresActionReviewStore implements ActionReviewStore {
  constructor(private readonly database: DatabaseService) {}

  async create(context: ActionReviewContext, mode: ActionReviewMode, payload: Record<string, unknown>) {
    assertActionType(mode);
    const config = runtimeConfig();
    return this.database.tenantTransaction(context.customerId, async (client) => {
      await client.query(
        `UPDATE ${config.schema}.action_reviews
         SET status = CASE WHEN status = 'committed' THEN 'committed' ELSE 'expired' END,
             payload = '{}'::jsonb,
             payload_hash = CASE WHEN status = 'committed' THEN 'redacted' ELSE 'expired' END,
             invalidated_at = now(), updated_at = now()
         WHERE customer_id = $1 AND status IN ('reviewed', 'confirmed', 'committed') AND expires_at <= now()`,
        [context.customerId],
      );
      await client.query(
        `UPDATE ${config.schema}.action_reviews
         SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'invalidated' END,
             payload = '{}'::jsonb, payload_hash = 'invalidated',
             invalidated_at = now(), updated_at = now()
         WHERE session_id = $1 AND customer_id = $2 AND status IN ('reviewed', 'confirmed')`,
        [context.sessionId, context.customerId],
      );
      const { rows } = await client.query<{ review_id: string; command_id: string; expires_at: Date }>(
        `INSERT INTO ${config.schema}.action_reviews
           (session_id, customer_id, action_type, payload, payload_hash, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, now() + interval '10 minutes')
         RETURNING review_id, command_id, expires_at`,
        [context.sessionId, context.customerId, mode, JSON.stringify(payload), payloadHash(payload)],
      );
      return { reviewId: rows[0].review_id, commandId: rows[0].command_id, expiresAt: rows[0].expires_at.toISOString() };
    });
  }

  async confirm(context: ActionReviewContext, reviewId: string): Promise<void> {
    const config = runtimeConfig();
    const result = await this.database.tenantTransaction(context.customerId, (client) => client.query(
      `UPDATE ${config.schema}.action_reviews
       SET status = 'confirmed', confirmed_at = now(), updated_at = now()
       WHERE review_id = $1 AND session_id = $2 AND customer_id = $3
         AND status = 'reviewed' AND expires_at > now()
       RETURNING review_id`,
      [reviewId, context.sessionId, context.customerId],
    ));
    if (!result.rows[0]) throw new Error("The displayed review is unavailable, expired, or already used.");
  }

  async current(context: ActionReviewContext): Promise<CurrentActionReview | null> {
    const config = runtimeConfig();
    return this.database.tenantTransaction(context.customerId, async (client) => {
      await client.query(
        `UPDATE ${config.schema}.action_reviews
         SET status = 'expired', payload = '{}'::jsonb, payload_hash = 'expired',
             invalidated_at = now(), updated_at = now()
         WHERE session_id = $1 AND customer_id = $2
           AND status IN ('reviewed', 'confirmed') AND expires_at <= now()`,
        [context.sessionId, context.customerId],
      );
      const { rows } = await client.query<{
        review_id: string; command_id: string; action_type: string;
        status: "reviewed" | "confirmed"; payload: Record<string, unknown>; expires_at: Date;
      }>(
        `SELECT review_id, command_id, action_type, status, payload, expires_at
         FROM ${config.schema}.action_reviews
         WHERE session_id = $1 AND customer_id = $2
           AND status IN ('reviewed', 'confirmed') AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [context.sessionId, context.customerId],
      );
      const row = rows[0];
      return row ? {
        reviewId: row.review_id,
        commandId: row.command_id,
        actionType: row.action_type,
        status: row.status,
        payload: row.payload,
        expiresAt: row.expires_at.toISOString(),
      } : null;
    });
  }

  async cancel(context: ActionReviewContext, reviewId: string): Promise<void> {
    const config = runtimeConfig();
    const result = await this.database.tenantTransaction(context.customerId, (client) => client.query(
      `UPDATE ${config.schema}.action_reviews
       SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'invalidated' END,
           payload = '{}'::jsonb, payload_hash = 'invalidated',
           invalidated_at = now(), updated_at = now()
       WHERE review_id = $1 AND session_id = $2 AND customer_id = $3
         AND status IN ('reviewed', 'confirmed')
       RETURNING review_id`,
      [reviewId, context.sessionId, context.customerId],
    ));
    if (!result.rows[0]) throw new Error("The displayed review is unavailable, expired, or already used.");
  }

  async consume(context: ActionReviewContext, reviewId: string, mode: ActionReviewMode, payload: Record<string, unknown>): Promise<string> {
    assertActionType(mode);
    const config = runtimeConfig();
    const { rows } = await this.database.tenantTransaction(context.customerId, (client) => client.query<{ command_id: string }>(
      `UPDATE ${config.schema}.action_reviews
       SET status = 'committed', committed_at = now(), updated_at = now()
       WHERE review_id = $1 AND session_id = $2 AND customer_id = $3
         AND action_type = $4 AND payload_hash = $5
         AND status IN ('confirmed', 'committed') AND expires_at > now()
       RETURNING command_id`,
      [reviewId, context.sessionId, context.customerId, mode, payloadHash(payload)],
    ));
    if (!rows[0]) throw new Error("Display and explicitly confirm the current details before continuing.");
    return rows[0].command_id;
  }

  async clear(context: ActionReviewContext): Promise<void> {
    const config = runtimeConfig();
    await this.database.tenantTransaction(context.customerId, (client) => client.query(
      `UPDATE ${config.schema}.action_reviews
       SET status = CASE
             WHEN status = 'committed' THEN 'committed'
             WHEN expires_at <= now() THEN 'expired'
             ELSE 'invalidated'
           END,
           payload = '{}'::jsonb,
           payload_hash = CASE WHEN status = 'committed' THEN 'redacted' ELSE 'invalidated' END,
           invalidated_at = CASE WHEN status = 'committed' THEN invalidated_at ELSE now() END,
           updated_at = now()
       WHERE session_id = $1 AND customer_id = $2 AND status IN ('reviewed', 'confirmed', 'committed')`,
      [context.sessionId, context.customerId],
    ));
  }
}

export class MemoryActionReviewStore implements ActionReviewStore {
  private readonly records = new Map<string, { context: ActionReviewContext; mode: ActionReviewMode; payload: Record<string, unknown>; payloadHash: string; status: string; commandId: string; expiresAt: string }>();
  async create(context: ActionReviewContext, mode: ActionReviewMode, payload: Record<string, unknown>) {
    assertActionType(mode);
    await this.clear(context);
    const reviewId = randomUUID();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    this.records.set(reviewId, { context, mode, payload, payloadHash: payloadHash(payload), status: "reviewed", commandId: randomUUID(), expiresAt });
    return { reviewId, commandId: this.records.get(reviewId)!.commandId, expiresAt };
  }
  async current(context: ActionReviewContext) {
    const entry = [...this.records.entries()].reverse().find(([, record]) =>
      sameContext(record.context, context) && ["reviewed", "confirmed"].includes(record.status) && Date.parse(record.expiresAt) > Date.now());
    return entry ? { reviewId: entry[0], commandId: entry[1].commandId, actionType: entry[1].mode,
      status: entry[1].status as "reviewed" | "confirmed", payload: entry[1].payload, expiresAt: entry[1].expiresAt } : null;
  }
  async confirm(context: ActionReviewContext, reviewId: string) {
    const record = this.records.get(reviewId);
    if (!record || record.status !== "reviewed" || !sameContext(record.context, context)) throw new Error("The displayed review is unavailable, expired, or already used.");
    record.status = "confirmed";
  }
  async consume(context: ActionReviewContext, reviewId: string, mode: ActionReviewMode, payload: Record<string, unknown>) {
    assertActionType(mode);
    const record = this.records.get(reviewId);
    if (!record || !["confirmed", "committed"].includes(record.status) || record.mode !== mode || record.payloadHash !== payloadHash(payload) || !sameContext(record.context, context)) throw new Error("Display and explicitly confirm the current details before continuing.");
    record.status = "committed";
    return record.commandId;
  }
  async cancel(context: ActionReviewContext, reviewId: string) {
    const record = this.records.get(reviewId);
    if (!record || !["reviewed", "confirmed"].includes(record.status) || !sameContext(record.context, context)) throw new Error("The displayed review is unavailable, expired, or already used.");
    record.status = "invalidated";
    record.payload = {};
  }
  async clear(context: ActionReviewContext) {
    for (const record of this.records.values()) if (sameContext(record.context, context)) {
      if (record.status !== "committed") record.status = "invalidated";
      record.payload = {};
    }
  }
}

function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(sortValue(payload))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortValue(child)]));
  return value;
}

function sameContext(left: ActionReviewContext, right: ActionReviewContext): boolean {
  return left.sessionId === right.sessionId && left.customerId === right.customerId;
}

function assertActionType(value: string): void {
  if (!/^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9-]{1,63}$/.test(value)) {
    throw new Error("Action review type must be a bounded namespaced identifier.");
  }
}
