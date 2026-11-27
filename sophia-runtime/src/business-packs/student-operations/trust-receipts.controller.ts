import { enqueueFields, cancelFields, enqueuePayment, cancelPayment } from './trust-payment-dispatch.js';
import { proposalCommand, receiptProposal, recordProposal } from './trust-receipt-proposals.js';
import { lockSplitInvoices } from './trust-split-reservations.js';
import { availableTrustPaymentIds, currentTrustInvoice, currentPaymentList, importedInvoicePayments, trustOverpaymentCandidates, trustReceiptPaymentCandidates } from './trust-receipt-payment-candidates.js';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header,
  Headers, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, StreamableFile, UploadedFile,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import { analysisToday } from './student-document-analysis-state.js';
import { StudentOperationsWorkspaceGuard } from './student-operations-workspace.guard.js';
import { StudentOperationsWorkspaceService, type StudentOperationsWorkspacePrincipal } from './student-operations-workspace.service.js';

type Request = {studentOperationsPrincipal: StudentOperationsWorkspacePrincipal; studentOperationsCorrelationId?: string};
type Evidence = {buffer: Buffer; mimetype: string};
export const receiptFields = z.object({
  statementFileName: z.string().trim().min(1).max(255).regex(/^[^/\\\x00-\x1f\x7f]+\.csv$/i).optional(),
  statementFileSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  statementRecord: z.string().regex(/^[1-9]\d{0,3}$/).transform(Number).pipe(z.number().int().min(2).max(1001)).optional(),
  importedPaymentId: z.uuid().optional(),
  importedPaymentAmount: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/).optional(),
  receivedOn: z.iso.date(),
  amount: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/).refine(value => Number(value) > 0),
  account: z.string().trim().min(1).max(120),
  bankTransactionId: z.string().trim().max(150).default(''),
  paymentPurpose: z.string().trim().max(240).default(''),
  reference: z.string().trim().max(150).default(''),
}).strict();

const paymentLinkFields = z.object({decisionNote: z.string().trim().max(500).optional()}).strict();

function linkDecisionNote(body: unknown) {
  const parsed = paymentLinkFields.safeParse(body);
  if (!parsed.success) throw new BadRequestException('Use a decision note of up to 500 characters.');
  return parsed.data.decisionNote || null;
}

const observationFields = `jsonb_build_object('id',o.observation_id,'firstSeenAt',o.first_seen_at,
                'paymentDate',o.payment_date,'amount',o.amount::text,'currency',o.currency_code,'isReconciled',o.is_reconciled)`;

export function manager(request: Request) {
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
  constructor(private readonly database: DatabaseService, private readonly workspace: StudentOperationsWorkspaceService) {}
  private get table() { return runtimeConfig().schema + '.student_trust_receipt_verifications'; }

  private get links() { return runtimeConfig().schema + '.student_trust_receipt_payment_links'; }

  private get candidates() { return trustReceiptPaymentCandidates(runtimeConfig().schema); }

  private get claims() { return runtimeConfig().schema + '.student_trust_reconciliation_claims'; }

  private get checks() { return runtimeConfig().schema + '.student_trust_payment_reconciliation_checks'; }

  private get excessLinks() { return runtimeConfig().schema + '.student_trust_receipt_overpayment_links'; }

  private get excessCandidates() { return trustOverpaymentCandidates(runtimeConfig().schema, 'r'); }

  @Post(':receiptId/dispatch')
  enqueue(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,@Param('invoiceId',ParseUUIDPipe) invoice:string,
    @Param('receiptId',ParseUUIDPipe) receipt:string,@Body() body:unknown) {
    const p=manager(request),parsed=enqueueFields.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Review the approval and enter a release reason.');
    return this.database.tenantTransaction(p.tenantId,db=>enqueuePayment(db,runtimeConfig().schema,[p.tenantId,connection,invoice,receipt],p.identityUserId,parsed.data));
  }

  @Post(':receiptId/dispatch/cancel')
  cancelDispatch(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,@Param('invoiceId',ParseUUIDPipe) invoice:string,
    @Param('receiptId',ParseUUIDPipe) receipt:string,@Body() body:unknown) {
    const p=manager(request),parsed=cancelFields.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Choose the dispatch and enter a cancellation reason.');
    return this.database.tenantTransaction(p.tenantId,db=>cancelPayment(db,runtimeConfig().schema,[p.tenantId,connection,invoice,receipt],p.identityUserId,parsed.data));
  }

  @Get(':receiptId/proposal')
  @Header('Cache-Control','private, no-store')
  proposal(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,@Param('invoiceId',ParseUUIDPipe) invoice:string,
    @Param('receiptId',ParseUUIDPipe) receipt:string) {
    const p=manager(request);
    return this.database.tenantReadTransaction(p.tenantId,db=>receiptProposal(db,runtimeConfig().schema,[p.tenantId,connection,invoice,receipt],p.identityUserId));
  }

  @Post(':receiptId/proposal')
  changeProposal(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,@Param('invoiceId',ParseUUIDPipe) invoice:string,
    @Param('receiptId',ParseUUIDPipe) receipt:string,@Body() body:unknown) {
    const p=manager(request),parsed=proposalCommand.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Review the receipt details and enter a reason.');
    return this.database.tenantTransaction(p.tenantId,db=>recordProposal(db,runtimeConfig().schema,[p.tenantId,connection,invoice,receipt],
      p.identityUserId,parsed.data));
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
       verifier.name AS "verifiedByName", payment_linker.name AS "paymentLinkedByName", l.linked_at AS "paymentLinkedAt", l.decision_note AS "paymentLinkNote",
       credit_linker.name AS "overpaymentLinkedByName", checker.name AS "reconciliationCheckedByName",
       reference, bank_transaction_id AS "bankTransactionId", payment_purpose AS "paymentPurpose", verified_at AS "verifiedAt", invoice_due_at_verification::text AS "invoiceDue", imported_payment_amount::text AS "importedPaymentAmount",
       (SELECT d.deposit_id FROM ${runtimeConfig().schema}.student_trust_staged_deposits d
         WHERE d.customer_id=r.customer_id AND d.connection_id=r.connection_id AND lower(d.account_label)=lower(r.account_label)
           AND d.bank_transaction_id=r.bank_transaction_id AND d.received_on=r.received_on AND d.amount=r.amount
           AND EXISTS (SELECT 1 FROM ${runtimeConfig().schema}.student_trust_invoice_match_decisions decision
             WHERE decision.customer_id=d.customer_id AND decision.connection_id=d.connection_id AND decision.deposit_id=d.deposit_id)
       ) AS "reviewedDepositId",
       CASE WHEN statement_record IS NOT NULL THEN jsonb_build_object(
         'name',statement_file_name,'sha256',statement_file_sha256,'record',statement_record) END AS "statementSource",
       evidence_type IS NOT NULL AS "hasEvidence", l.payment_id AS "linkedPaymentId", l.payment_amount::text AS "linkedAmount",
       (SELECT candidate."isReconciled" FROM (${this.candidates}) candidate
         WHERE candidate.id=l.payment_id AND candidate.amount=l.payment_amount) AS "linkedPaymentReconciled",
       ARRAY(SELECT ${observationFields}
         FROM ${runtimeConfig().schema}.student_xero_payment_observations o
         WHERE o.customer_id=r.customer_id AND o.xero_connection_id=r.connection_id
           AND o.xero_invoice_id=r.invoice_id AND o.payment_id=l.payment_id
         ORDER BY o.first_seen_at DESC,o.observation_id DESC LIMIT 6) AS "paymentObservations",
       check_record.checked_at AS "reconciliationCheckedAt", check_record.reported_reconciled_on::text AS "reportedReconciledOn",
       x.overpayment_id AS "linkedOverpaymentId", x.linked_at AS "overpaymentLinkedAt", x.decision_note AS "overpaymentLinkNote",
       ARRAY(SELECT candidate.id FROM (${this.excessCandidates}) candidate
         WHERE NOT EXISTS (SELECT 1 FROM ${this.excessLinks} used WHERE used.customer_id=r.customer_id
           AND used.connection_id=r.connection_id AND used.overpayment_id=candidate.id AND used.verification_id<>r.verification_id)
         ORDER BY candidate.id) AS "possibleOverpaymentIds",
       ARRAY(${availableTrustPaymentIds(runtimeConfig().schema, true)} ORDER BY candidate.id) AS "candidateIds"
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
      [p.tenantId,connection,invoice,p.identityUserId])).rows.map(row => ({
        ...row, paymentObservations:row.paymentObservations.slice(0,5),
        observationCursor:row.paymentObservations.length > 5 ? row.paymentObservations[4].id : null,
      })));
  }

  @Post(':id/link/:paymentId')
  async link(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) id: string,
    @Param('paymentId',ParseUUIDPipe) payment: string, @Body() body: unknown = {}) {
    const p = manager(request);
    const note = linkDecisionNote(body);
    const params = [p.tenantId,connection,invoice,id,payment];
    return this.database.tenantTransaction(p.tenantId, async db => {
      const inserted = await db.query(`INSERT INTO ${this.links}
        (customer_id,connection_id,verification_id,payment_id,payment_amount,linked_by,decision_note)
        SELECT r.customer_id,r.connection_id,r.verification_id,candidate.id,candidate.amount,$6,$7
        FROM ${this.table} r CROSS JOIN LATERAL (${this.candidates}) candidate
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND candidate.id=$5
          AND candidate."paymentListCurrent"
        ON CONFLICT DO NOTHING`, [...params,p.identityUserId,note]);
      if (!inserted.rowCount) {
        const existing = await db.query(`SELECT l.decision_note FROM ${this.links} l JOIN ${this.table} r USING (customer_id,connection_id,verification_id)
          WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND l.payment_id=$5`, params);
        if (existing.rowCount && note && note !== existing.rows[0].decision_note) throw new ConflictException('This payment link was already saved with a different decision note.');
        if (!existing.rowCount) throw new ConflictException('This payment or receipt has changed. Review the latest imported payments.');
      }
      return {paymentId:payment};
    });
  }

  @Get(':id/payments/:paymentId/observations')
  @Header('Cache-Control','private, no-store')
  async olderObservations(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) receipt: string,
    @Param('paymentId',ParseUUIDPipe) payment: string, @Query('before',ParseUUIDPipe) before: string) {
    const p = manager(request);
    const observations = runtimeConfig().schema + '.student_xero_payment_observations';
    return this.database.tenantReadTransaction(p.tenantId, async db => {
      const {rows} = await db.query(`SELECT ${observationFields} AS entry
        FROM ${this.table} r JOIN ${this.links} l USING (customer_id,connection_id,verification_id)
        JOIN ${observations} o ON o.customer_id=r.customer_id AND o.xero_connection_id=r.connection_id
          AND o.xero_invoice_id=r.invoice_id AND o.payment_id=l.payment_id
        JOIN ${observations} previous ON previous.customer_id=o.customer_id AND previous.xero_connection_id=o.xero_connection_id
          AND previous.xero_invoice_id=o.xero_invoice_id
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4
          AND l.payment_id=$5 AND previous.payment_id=o.payment_id AND previous.observation_id=$6
          AND (o.first_seen_at,o.observation_id)<(previous.first_seen_at,previous.observation_id)
        ORDER BY o.first_seen_at DESC,o.observation_id DESC LIMIT 11`,[p.tenantId,connection,invoice,receipt,payment,before]);
      const entries = rows.slice(0,10).map(row => row.entry);
      return {entries, nextCursor:rows.length > 10 ? entries[9].id : null};
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
    @Param('paymentId',ParseUUIDPipe) payment: string, @Body() body: unknown = {}) {
    const principal = manager(request);
    const parsed = z.object({reportedReconciledOn: z.iso.date().optional()}).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('Enter a valid reconciliation date.');
    const date = parsed.data.reportedReconciledOn ?? null;
    if (date && date > analysisToday()) {
      throw new BadRequestException('The reconciliation date cannot be in the future.');
    }
    const scope = `FROM ${this.table} r JOIN ${this.links} l USING (customer_id,connection_id,verification_id)`;
    const filter = `r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND l.payment_id=$5`;
    const params = [principal.tenantId, connection, invoice, receipt, payment];
    return this.database.tenantTransaction(principal.tenantId, async db => {
      await db.query(`INSERT INTO ${this.checks} (customer_id,connection_id,payment_id,checked_by,reported_reconciled_on)
        SELECT l.customer_id,l.connection_id,l.payment_id,$6,$7::date ${scope}
        CROSS JOIN LATERAL (${this.candidates}) candidate
        WHERE ${filter} AND candidate.id=l.payment_id AND candidate.amount=l.payment_amount
          AND candidate."isReconciled" IS NOT TRUE
        ON CONFLICT DO NOTHING`, [...params, principal.identityUserId,date]);
      const result = await db.query(`SELECT c.checked_at AS "checkedAt", c.reported_reconciled_on::text AS "reportedReconciledOn" ${scope}
        JOIN ${this.checks} c ON c.customer_id=l.customer_id AND c.connection_id=l.connection_id AND c.payment_id=l.payment_id
        WHERE ${filter}`, params);
      if (!result.rowCount) throw new ConflictException('The linked payment has changed. Review its latest reconciliation status.');
      if (date && result.rows[0].reportedReconciledOn !== date) throw new ConflictException('This check was already saved with a different reconciliation date.');
      return result.rows[0];
    });
  }

  @Post(':id/overpayments/:overpaymentId')
  async linkOverpayment(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Param('id',ParseUUIDPipe) receipt: string,
    @Param('overpaymentId',ParseUUIDPipe) overpayment: string, @Body() body: unknown = {}) {
    const principal = manager(request);
    const note = linkDecisionNote(body);
    const params = [principal.tenantId, connection, invoice, receipt, overpayment];
    return this.database.tenantTransaction(principal.tenantId, async db => {
      const inserted = await db.query(`INSERT INTO ${this.excessLinks}
        (customer_id,connection_id,verification_id,overpayment_id,excess_amount,linked_by,decision_note)
        SELECT r.customer_id,r.connection_id,r.verification_id,candidate.id,candidate.total,$6,$7
        FROM ${this.table} r CROSS JOIN LATERAL (${this.excessCandidates}) candidate
        WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND candidate.id=$5
        ON CONFLICT DO NOTHING`, [...params,principal.identityUserId,note]);
      if (!inserted.rowCount) {
        const existing = await db.query(`SELECT x.decision_note FROM ${this.excessLinks} x JOIN ${this.table} r USING (customer_id,connection_id,verification_id)
          WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4 AND x.overpayment_id=$5`, params);
        if (existing.rowCount && note && note !== existing.rows[0].decision_note) throw new ConflictException('This overpayment link was already saved with a different decision note.');
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
    const p = request.studentOperationsPrincipal;
    const correlation = request.studentOperationsCorrelationId ?? randomUUID();
    const audit = (outcome: 'allowed' | 'denied') => this.workspace.recordAccess(
      p.tenantId, p.identityUserId, outcome, correlation,
      {action:'trust_receipt.evidence_download', connectionId:connection, invoiceId:invoice, receiptId:id},
    );
    if (p.role !== 'chief_executive') {
      await audit('denied');
      throw new ForbiddenException();
    }
    const row = await this.database.tenantReadTransaction(p.tenantId, async db => (await db.query(
      `SELECT evidence,evidence_type FROM ${this.table} WHERE customer_id=$1 AND connection_id=$2 AND invoice_id=$3 AND verification_id=$4`,
      [p.tenantId,connection,invoice,id])).rows[0]);
    await audit(row?.evidence ? 'allowed' : 'denied');
    if (!row?.evidence) throw new NotFoundException();
    return new StreamableFile(row.evidence, {type: row.evidence_type, disposition: 'attachment; filename="bank-verification.' + (row.evidence_type === 'image/png' ? 'png' : 'jpg') + '"'});
  }

  @Post()
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:5242880, files:1, fields:11, fieldSize:2048, parts:13}}))
  async verify(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Headers('idempotency-key') key: string,
    @Body() body: unknown, @UploadedFile() file?: Evidence) {
    const p = manager(request);
    const parsed = receiptFields.safeParse(body);
    if (!parsed.success || !z.uuid().safeParse(key).success) throw new BadRequestException('Check the receipt details.');
    const {receivedOn,amount,account,reference,paymentPurpose,bankTransactionId} = parsed.data;
    const {statementFileName,statementFileSha256,statementRecord} = parsed.data;
    const hasSource = statementFileName !== undefined || statementFileSha256 !== undefined || statementRecord !== undefined;
    if (hasSource && !(statementFileName && statementFileSha256 && statementRecord && bankTransactionId)) {
      throw new BadRequestException('Include the statement filename, fingerprint, record number and bank transaction ID together.');
    }
    const importedId = parsed.data.importedPaymentId?.toLowerCase();
    const importedAmount = parsed.data.importedPaymentAmount;
    if (!!importedId !== !!importedAmount || (importedAmount && (Number(importedAmount) <= 0 || Number(importedAmount) > Number(amount)))) {
      throw new BadRequestException('Check the selected payment and full bank receipt amount.');
    }
    const type = receiptEvidenceType(file);
    const [whole, fraction = ''] = amount.split('.');
    const centsAmount = whole + '.' + fraction.padEnd(2, '0');
    const fingerprint = (formattedAmount: string) => {
      const parts = [connection,invoice,receivedOn,formattedAmount,account,reference,type];
      if (paymentPurpose) parts.push(paymentPurpose);
      const receiptPayload = importedId ? {parts,bankTransactionId,importedId,importedAmount:Number(importedAmount)} : bankTransactionId ? {parts,bankTransactionId} : parts;
      const payload = hasSource ? {receiptPayload,statementFileName,statementFileSha256,statementRecord} : receiptPayload;
      return createHash('sha256').update(JSON.stringify(payload)).update(file?.buffer ?? '').digest('hex');
    };
    const hash = fingerprint(centsAmount);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(p.tenantId, async db => {
      if (bankTransactionId) {
        // Serialize final match reviews with verification of the same staged bank movement.
        await db.query(`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('/',d.customer_id,d.connection_id,d.deposit_id),0))
          FROM ${schema}.student_trust_staged_deposits d WHERE d.customer_id=$1 AND d.connection_id=$2
          AND ((lower(d.account_label)=lower($3) AND d.bank_transaction_id=$4)
            OR (d.statement_file_sha256=$5 AND d.statement_record=$6))
          ORDER BY d.deposit_id`,[p.tenantId,connection,account,bankTransactionId,statementFileSha256??null,statementRecord??null]);
      }
      await lockSplitInvoices(db,p.tenantId,connection,[invoice]);
      const inserted = await db.query(`INSERT INTO ${this.table}
        (customer_id,connection_id,invoice_id,verification_id,verified_by,received_on,amount,account_label,reference,
         evidence,evidence_type,payload_hash,invoice_due_at_verification,payment_purpose,bank_transaction_id,imported_payment_amount,
         statement_file_name,statement_file_sha256,statement_record)
        SELECT i.customer_id,i.xero_connection_id,i.xero_invoice_id,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,i.amount_due,$13,$14,$15::numeric,$16,$17,$18
        FROM ${schema}.student_operations_xero_invoices i JOIN ${schema}.student_operations_xero_sync_configurations c
          USING (customer_id,xero_connection_id)
        WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_invoice_id=$3
          AND c.enabled AND c.organisation_role='trust' AND i.currency_code='AUD' AND i.invoice_type='ACCREC'
          AND ${currentTrustInvoice(schema, 'i')}
          AND (${importedId ? `i.invoice_status IN ('PAID','AUTHORISED') AND ${currentPaymentList}
            AND ($15::numeric=$7::numeric OR (i.invoice_status='PAID' AND i.amount_due=0))
            AND EXISTS (SELECT 1 FROM (${importedInvoicePayments()}) payment
              WHERE payment.id=$19::text AND payment.payment_date=$6::date::text AND payment.amount=$15::numeric)
            AND NOT EXISTS (SELECT 1 FROM ${this.table} prior
              WHERE prior.customer_id=i.customer_id AND prior.connection_id=i.xero_connection_id AND prior.invoice_id=i.xero_invoice_id
              AND prior.received_on=$6::date AND prior.amount=$7::numeric AND prior.verification_id<>$4
              AND NOT EXISTS (SELECT 1 FROM ${this.links} l WHERE l.customer_id=prior.customer_id AND l.verification_id=prior.verification_id)
              AND (prior.bank_transaction_id IS NULL OR $14::text IS NULL OR prior.bank_transaction_id=$14))`
            : "i.invoice_status='AUTHORISED' AND i.amount_due>0"})
          AND $6::date <= (now() AT TIME ZONE 'Australia/Brisbane')::date
        ON CONFLICT DO NOTHING RETURNING verification_id`,
        [p.tenantId,connection,invoice,key,p.identityUserId,receivedOn,amount,account,reference,file?.buffer??null,type,hash,paymentPurpose || null,bankTransactionId || null,importedAmount ?? null,
          statementFileName ?? null,statementFileSha256 ?? null,statementRecord ?? null,...(importedId ? [importedId] : [])]);
      if (inserted.rowCount) {
        const reserved=await db.query(`SELECT held.bank_transaction_id FROM ${schema}.student_trust_split_allocations a
          JOIN ${schema}.student_trust_staged_deposits held USING(customer_id,connection_id,deposit_id)
          WHERE a.customer_id=$1 AND a.connection_id=$2 AND (a.invoice_id=$3 OR a.deposit_id IN
            (SELECT d.deposit_id FROM ${schema}.student_trust_staged_deposits d WHERE d.customer_id=$1 AND d.connection_id=$2
            AND ((lower(d.account_label)=lower($4) AND d.bank_transaction_id=$5)
              OR (d.statement_file_sha256=$6 AND d.statement_record=$7)))) ORDER BY a.deposit_id LIMIT 1`,
          [p.tenantId,connection,invoice,account,bankTransactionId||null,statementFileSha256??null,statementRecord??null]);
        if (reserved.rowCount) throw new ConflictException({errorCode:'trust_active_split',bankTransactionId:reserved.rows[0].bank_transaction_id,
          message:'Review and release the active split reservation before verifying this receipt.'});
      }
      if (!inserted.rowCount) {
        const prior = await db.query(`SELECT payload_hash FROM ${this.table} WHERE customer_id=$1 AND verification_id=$2 AND verified_by=$3`,[p.tenantId,key,p.identityUserId]);
        const priorHash = prior.rows[0]?.payload_hash;
        // Older receipts fingerprinted the entered decimal scale. Only equivalent spellings may replay.
        const matchesLegacy = priorHash && priorHash !== hash && centsAmount.endsWith('0') &&
          (priorHash === fingerprint(centsAmount.slice(0, -1)) ||
            (centsAmount.endsWith('.00') && priorHash === fingerprint(whole)));
        if (priorHash !== hash && !matchesLegacy) {
          if (bankTransactionId && !priorHash) {
            const existing = await db.query(`SELECT i.invoice_number, r.invoice_id, r.received_on::text, r.amount::text
              FROM ${this.table} r
              JOIN ${schema}.student_operations_xero_invoices i
                ON i.customer_id=r.customer_id AND i.xero_connection_id=r.connection_id AND i.xero_invoice_id=r.invoice_id
              JOIN ${schema}.student_operations_xero_sync_configurations cfg
                ON cfg.customer_id=r.customer_id AND cfg.xero_connection_id=r.connection_id
              WHERE r.customer_id=$1 AND r.connection_id=$2 AND lower(r.account_label)=lower($3)
                AND r.bank_transaction_id=$4 AND cfg.enabled AND cfg.organisation_role='trust'`,
              [p.tenantId,connection,account,bankTransactionId]);
            if (existing.rowCount) throw new ConflictException({
              errorCode:'trust_bank_transaction_already_verified',
              message:'This bank transaction is already verified in Sophia.',
              invoiceNumber:existing.rows[0].invoice_number,
              invoiceId:existing.rows[0].invoice_id, receivedOn:existing.rows[0].received_on, amount:existing.rows[0].amount,
            });
          }
          if (importedId) throw new ConflictException('Review existing verifications and refresh the imported payment before saving.');
          throw new ConflictException('Review existing receipts, payment date and current TRUST invoice before saving.');
        }
      }
      if (inserted.rowCount && importedId) {
        const linked = await db.query(`INSERT INTO ${this.links}
          (customer_id,connection_id,verification_id,payment_id,payment_amount,linked_by)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [p.tenantId,connection,key,importedId,importedAmount,p.identityUserId]);
        if (!linked.rowCount) throw new ConflictException('This imported payment already has a receipt link.');
      }
      return {id:key};
    });
  }
}
