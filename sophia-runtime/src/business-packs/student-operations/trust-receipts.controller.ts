import { currentTrustInvoice, trustReceiptPaymentCandidates } from './trust-receipt-payment-candidates.js';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header,
  Headers, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, StreamableFile, UploadedFile,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import { StudentOperationsWorkspaceGuard } from './student-operations-workspace.guard.js';
import type { StudentOperationsWorkspacePrincipal } from './student-operations-workspace.service.js';

type Request = {studentOperationsPrincipal: StudentOperationsWorkspacePrincipal};
type Evidence = {buffer: Buffer; mimetype: string};
const fields = z.object({
  receivedOn: z.iso.date(),
  amount: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/).refine(value => Number(value) > 0),
  account: z.string().trim().min(1).max(120),
  paymentPurpose: z.string().trim().max(240).default(''),
  reference: z.string().trim().max(150).default(''),
}).strict();

function manager(request: Request) {
  const principal = request.studentOperationsPrincipal;
  if (principal.role !== 'chief_executive') throw new ForbiddenException();
  return principal;
}

export function receiptEvidenceType(file?: Evidence) {
  if (!file) return null;
  const bytes = file.buffer;
  if (file.mimetype === 'image/png' && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return file.mimetype;
  if (file.mimetype === 'image/jpeg' && bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))) return file.mimetype;
  throw new BadRequestException('Select a PNG or JPEG bank screenshot.');
}

@Controller('business-packs/student-operations/v1/workspace/trust-receipts/:connectionId/:invoiceId')
@UseGuards(StudentOperationsWorkspaceGuard)
export class TrustReceiptsController {
  constructor(private readonly database: DatabaseService) {}
  private get table() { return runtimeConfig().schema + '.student_trust_receipt_verifications'; }

  private get links() { return runtimeConfig().schema + '.student_trust_receipt_payment_links'; }

  private get candidates() { return trustReceiptPaymentCandidates(runtimeConfig().schema); }

  private get claims() { return runtimeConfig().schema + '.student_trust_reconciliation_claims'; }

  private get checks() { return runtimeConfig().schema + '.student_trust_payment_reconciliation_checks'; }

  private get excessLinks() { return runtimeConfig().schema + '.student_trust_receipt_overpayment_links'; }

  private get excessCandidates() {
    const schema = runtimeConfig().schema;
    return `SELECT credit.xero_invoice_id AS id, credit.total
         FROM ${schema}.student_operations_xero_invoices invoice
         JOIN ${schema}.student_operations_xero_sync_configurations cfg USING (customer_id,xero_connection_id)
         JOIN ${schema}.student_operations_xero_invoices credit USING (customer_id,xero_connection_id,xero_contact_id)
         WHERE cfg.enabled AND cfg.organisation_role='trust'
           AND invoice.customer_id=r.customer_id AND invoice.xero_connection_id=r.connection_id AND invoice.xero_invoice_id=r.invoice_id
           AND r.amount > round(r.invoice_due_at_verification,2)
           AND credit.invoice_type='RECEIVE-OVERPAYMENT' AND credit.invoice_status IN ('PAID','AUTHORISED')
           AND credit.currency_code='AUD' AND credit.invoice_date=r.received_on
           AND credit.total=r.amount-round(r.invoice_due_at_verification,2)
           AND ${currentTrustInvoice(schema, 'invoice')}
           AND ${currentTrustInvoice(schema, 'credit')}`;
  }

  @Get()
  @Header('Cache-Control','private, no-store')
  list(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string, @Param('invoiceId',ParseUUIDPipe) invoice: string) {
    const p = manager(request);
    return this.database.tenantReadTransaction(p.tenantId, async db => (await db.query(
      `WITH staff AS MATERIALIZED (
         SELECT user_id::text AS id, nullif(trim(display_name),'') AS name
         FROM ${runtimeConfig().schema}.student_operations_advisor_roster WHERE customer_id=$1
       )
       SELECT verification_id AS id, received_on::text AS "receivedOn", amount::text, account_label AS account,
       claim.claim_id AS "reviewClaimId", owner.name AS "reviewOwnerName", claim.claimed_by=$4 AS "reviewOwnedByMe",
       verifier.name AS "verifiedByName", payment_linker.name AS "paymentLinkedByName", l.linked_at AS "paymentLinkedAt",
       credit_linker.name AS "overpaymentLinkedByName", checker.name AS "reconciliationCheckedByName",
       reference, payment_purpose AS "paymentPurpose", verified_at AS "verifiedAt", invoice_due_at_verification::text AS "invoiceDue",
       evidence_type IS NOT NULL AS "hasEvidence", l.payment_id AS "linkedPaymentId", l.payment_amount::text AS "linkedAmount",
       (SELECT candidate."isReconciled" FROM (${this.candidates}) candidate
         WHERE candidate.id=l.payment_id AND candidate.amount=l.payment_amount LIMIT 1) AS "linkedPaymentReconciled",
       check_record.checked_at AS "reconciliationCheckedAt",
       x.overpayment_id AS "linkedOverpaymentId", x.linked_at AS "overpaymentLinkedAt",
       ARRAY(SELECT candidate.id FROM (${this.excessCandidates}) candidate
         WHERE NOT EXISTS (SELECT 1 FROM ${this.excessLinks} used WHERE used.customer_id=r.customer_id
           AND used.connection_id=r.connection_id AND used.overpayment_id=candidate.id AND used.verification_id<>r.verification_id)
         ORDER BY candidate.id) AS "possibleOverpaymentIds",
       ARRAY(SELECT candidate.id FROM (${this.candidates}) candidate
         WHERE NOT EXISTS (SELECT 1 FROM ${this.links} used WHERE used.customer_id=r.customer_id
           AND used.connection_id=r.connection_id AND used.payment_id=candidate.id AND used.verification_id<>r.verification_id)
         ORDER BY candidate.id) AS "candidateIds"
       FROM ${this.table} r LEFT JOIN ${this.links} l USING (customer_id,connection_id,verification_id)
       LEFT JOIN ${this.excessLinks} x USING (customer_id,connection_id,verification_id)
       LEFT JOIN ${this.checks} check_record ON check_record.customer_id=l.customer_id
         AND check_record.connection_id=l.connection_id AND check_record.payment_id=l.payment_id
       LEFT JOIN ${this.claims} claim ON claim.customer_id=l.customer_id AND claim.connection_id=l.connection_id
         AND claim.payment_id=l.payment_id AND claim.released_at IS NULL
       LEFT JOIN staff owner ON owner.id=claim.claimed_by
       LEFT JOIN staff verifier ON verifier.id=r.verified_by
       LEFT JOIN staff payment_linker ON payment_linker.id=l.linked_by
       LEFT JOIN staff credit_linker ON credit_linker.id=x.linked_by
       LEFT JOIN staff checker ON checker.id=check_record.checked_by
       WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 ORDER BY verified_at DESC`,
      [p.tenantId,connection,invoice,p.identityUserId])).rows);
  }

  @Post(':id/link/:paymentId')
  async link(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) id: string,
    @Param('paymentId',ParseUUIDPipe) payment: string) {
    const p = manager(request);
    const params = [p.tenantId,connection,invoice,id,payment];
    return this.database.tenantTransaction(p.tenantId, async db => {
      const inserted = await db.query(`INSERT INTO ${this.links}
        (customer_id,connection_id,verification_id,payment_id,payment_amount,linked_by)
        SELECT r.customer_id,r.connection_id,r.verification_id,candidate.id,candidate.amount,$6
        FROM ${this.table} r CROSS JOIN LATERAL (${this.candidates}) candidate
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND candidate.id=$5
        ON CONFLICT DO NOTHING`, [...params,p.identityUserId]);
      if (!inserted.rowCount) {
        const existing = await db.query(`SELECT 1 FROM ${this.links} l JOIN ${this.table} r USING (customer_id,connection_id,verification_id)
          WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND l.payment_id=$5`, params);
        if (!existing.rowCount) throw new ConflictException('This payment or receipt has changed. Review the latest imported payments.');
      }
      return {paymentId:payment};
    });
  }

  @Get(':id/payments/:paymentId/claims')
  @Header('Cache-Control','private, no-store')
  async claimHistory(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) receipt: string,
    @Param('paymentId',ParseUUIDPipe) payment: string, @Query('before') before?: string) {
    const p = manager(request);
    if (before !== undefined && !z.uuid().safeParse(before).success) throw new BadRequestException('Invalid history cursor.');
    const params = [p.tenantId,connection,invoice,receipt,payment];
    const cursor = before ? `AND (c.claimed_at,c.claim_id) < (
      SELECT previous.claimed_at,previous.claim_id FROM ${this.claims} previous
      WHERE previous.customer_id=c.customer_id AND previous.connection_id=c.connection_id
        AND previous.payment_id=c.payment_id AND previous.claim_id=$6)` : '';
    if (before) params.push(before);
    return this.database.tenantReadTransaction(p.tenantId, async db => {
      const {rows} = await db.query(`SELECT c.claim_id AS id, c.claimed_at AS "claimedAt",
          c.released_at AS "releasedAt", nullif(trim(staff.display_name),'') AS "ownerName"
        FROM ${this.table} r JOIN ${this.links} l USING (customer_id,connection_id,verification_id)
        JOIN ${this.claims} c ON c.customer_id=l.customer_id AND c.connection_id=l.connection_id AND c.payment_id=l.payment_id
        LEFT JOIN ${runtimeConfig().schema}.student_operations_advisor_roster staff
          ON staff.customer_id=c.customer_id AND staff.user_id::text=c.claimed_by
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4
          AND l.payment_id=$5 ${cursor}
        ORDER BY c.claimed_at DESC,c.claim_id DESC LIMIT 11`,params);
      const entries = rows.slice(0,10);
      return {entries, nextCursor: rows.length > entries.length ? entries[entries.length-1].id : null};
    });
  }

  @Post(':id/payments/:paymentId/claim')
  async claimReview(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) receipt: string,
    @Param('paymentId',ParseUUIDPipe) payment: string) {
    const p = manager(request);
    const params = [p.tenantId,connection,invoice,receipt,payment,p.identityUserId];
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(p.tenantId, async db => {
      await db.query(`INSERT INTO ${this.claims} (customer_id,connection_id,payment_id,claimed_by)
        SELECT l.customer_id,l.connection_id,l.payment_id,$6 FROM ${this.table} r
        JOIN ${this.links} l USING (customer_id,connection_id,verification_id)
        JOIN ${schema}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=l.customer_id AND cfg.xero_connection_id=l.connection_id
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND l.payment_id=$5
          AND cfg.enabled AND cfg.organisation_role='trust' AND NOT EXISTS (
            SELECT 1 FROM (${this.candidates}) candidate
            WHERE candidate.id=l.payment_id AND candidate.amount=l.payment_amount AND candidate."isReconciled" IS TRUE)
        ON CONFLICT DO NOTHING`, params);
      const result = await db.query(`SELECT c.claim_id AS "claimId" FROM ${this.table} r
        JOIN ${this.links} l USING (customer_id,connection_id,verification_id)
        JOIN ${this.claims} c ON c.customer_id=l.customer_id AND c.connection_id=l.connection_id AND c.payment_id=l.payment_id
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4
          AND l.payment_id=$5 AND c.claimed_by=$6 AND c.released_at IS NULL`,params);
      if (!result.rowCount) throw new ConflictException('This follow-up is no longer available to claim.');
      return result.rows[0];
    });
  }

  @Post(':id/payments/:paymentId/claims/:claimId/release')
  async releaseReview(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) receipt: string,
    @Param('paymentId',ParseUUIDPipe) payment: string, @Param('claimId',ParseUUIDPipe) claim: string) {
    const p = manager(request);
    return this.database.tenantTransaction(p.tenantId, async db => {
      const result = await db.query(`UPDATE ${this.claims} c SET released_at=coalesce(c.released_at,now())
        FROM ${this.table} r JOIN ${this.links} l USING (customer_id,connection_id,verification_id)
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND l.payment_id=$5
          AND c.customer_id=l.customer_id AND c.connection_id=l.connection_id AND c.payment_id=l.payment_id
          AND c.claim_id=$6 AND c.claimed_by=$7 RETURNING c.claim_id AS "claimId"`,
        [p.tenantId,connection,invoice,receipt,payment,claim,p.identityUserId]);
      if (!result.rowCount) throw new ConflictException('Only the owner can release this claim.');
      return result.rows[0];
    });
  }

  @Post(':id/reconciliation-check/:paymentId')
  async attestReconciliation(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) receipt: string,
    @Param('paymentId',ParseUUIDPipe) payment: string) {
    const principal = manager(request);
    const scope = `FROM ${this.table} r JOIN ${this.links} l USING (customer_id,connection_id,verification_id)`;
    const filter = `r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND l.payment_id=$5`;
    const params = [principal.tenantId, connection, invoice, receipt, payment];
    return this.database.tenantTransaction(principal.tenantId, async db => {
      await db.query(`INSERT INTO ${this.checks} (customer_id,connection_id,payment_id,checked_by)
        SELECT l.customer_id,l.connection_id,l.payment_id,$6 ${scope}
        CROSS JOIN LATERAL (${this.candidates}) candidate
        WHERE ${filter} AND candidate.id=l.payment_id AND candidate.amount=l.payment_amount
          AND candidate."isReconciled" IS NOT TRUE
        ON CONFLICT DO NOTHING`, [...params, principal.identityUserId]);
      const result = await db.query(`SELECT c.checked_at AS "checkedAt" ${scope}
        JOIN ${this.checks} c ON c.customer_id=l.customer_id AND c.connection_id=l.connection_id AND c.payment_id=l.payment_id
        WHERE ${filter}`, params);
      if (!result.rowCount) throw new ConflictException('The linked payment has changed. Review its latest reconciliation status.');
      return result.rows[0];
    });
  }

  @Post(':id/overpayments/:overpaymentId')
  async linkOverpayment(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) receipt: string,
    @Param('overpaymentId',ParseUUIDPipe) overpayment: string) {
    const principal = manager(request);
    const params = [principal.tenantId, connection, invoice, receipt, overpayment];
    return this.database.tenantTransaction(principal.tenantId, async db => {
      const inserted = await db.query(`INSERT INTO ${this.excessLinks}
        (customer_id,connection_id,verification_id,overpayment_id,excess_amount,linked_by)
        SELECT r.customer_id,r.connection_id,r.verification_id,candidate.id,candidate.total,$6
        FROM ${this.table} r CROSS JOIN LATERAL (${this.excessCandidates}) candidate
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND candidate.id=$5
        ON CONFLICT DO NOTHING`, [...params,principal.identityUserId]);
      if (!inserted.rowCount) {
        const existing = await db.query(`SELECT 1 FROM ${this.excessLinks} x JOIN ${this.table} r USING (customer_id,connection_id,verification_id)
          WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND x.overpayment_id=$5`, params);
        if (!existing.rowCount) throw new ConflictException('Review the latest receipt and overpayment before confirming.');
      }
      return {overpaymentId: overpayment};
    });
  }

  @Get(':id/evidence')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  async evidence(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) id: string) {
    const p = manager(request);
    const row = await this.database.tenantReadTransaction(p.tenantId, async db => (await db.query(
      `SELECT evidence,evidence_type FROM ${this.table} WHERE customer_id=$1 AND connection_id=$2 AND invoice_id=$3 AND verification_id=$4`,
      [p.tenantId,connection,invoice,id])).rows[0]);
    if (!row?.evidence) throw new NotFoundException();
    return new StreamableFile(row.evidence, {type: row.evidence_type, disposition: 'attachment; filename="bank-verification.' + (row.evidence_type === 'image/png' ? 'png' : 'jpg') + '"'});
  }

  @Post()
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:5242880, files:1, fields:5, fieldSize:1024, parts:7}}))
  async verify(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Headers('idempotency-key') key: string,
    @Body() body: unknown, @UploadedFile() file?: Evidence) {
    const p = manager(request);
    const parsed = fields.safeParse(body);
    if (!parsed.success || !z.uuid().safeParse(key).success) throw new BadRequestException('Check the receipt details.');
    const {receivedOn,amount,account,reference,paymentPurpose} = parsed.data;
    const type = receiptEvidenceType(file);
    // Keep the original fingerprint for clients retrying receipts without a purpose.
    const fingerprint = [connection,invoice,receivedOn,amount,account,reference,type];
    if (paymentPurpose) fingerprint.push(paymentPurpose);
    const hash = createHash('sha256').update(JSON.stringify(fingerprint))
      .update(file?.buffer ?? '').digest('hex');
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(p.tenantId, async db => {
      const inserted = await db.query(`INSERT INTO ${this.table}
        (customer_id,connection_id,invoice_id,verification_id,verified_by,received_on,amount,account_label,reference,
         evidence,evidence_type,payload_hash,invoice_due_at_verification,payment_purpose)
        SELECT i.customer_id,i.xero_connection_id,i.xero_invoice_id,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,i.amount_due,$13
        FROM ${schema}.student_operations_xero_invoices i JOIN ${schema}.student_operations_xero_sync_configurations c
          USING (customer_id,xero_connection_id)
        WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_invoice_id=$3
          AND c.enabled AND c.organisation_role='trust' AND i.currency_code='AUD' AND i.invoice_type='ACCREC'
          AND ${currentTrustInvoice(schema, 'i')}
          AND i.invoice_status='AUTHORISED' AND i.amount_due>0 AND $6::date <= (now() AT TIME ZONE 'Australia/Brisbane')::date
        ON CONFLICT DO NOTHING RETURNING verification_id`,
        [p.tenantId,connection,invoice,key,p.identityUserId,receivedOn,amount,account,reference,file?.buffer??null,type,hash,paymentPurpose || null]);
      if (!inserted.rowCount) {
        const prior = await db.query(`SELECT payload_hash FROM ${this.table} WHERE customer_id=$1 AND verification_id=$2 AND verified_by=$3`,[p.tenantId,key,p.identityUserId]);
        if (prior.rows[0]?.payload_hash !== hash) throw new ConflictException('Review existing receipts, payment date and current TRUST invoice before saving.');
      }
      return {id:key};
    });
  }
}
