import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header,
  Headers, NotFoundException, Param, ParseUUIDPipe, Post, Req, StreamableFile, UploadedFile,
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

  @Get()
  @Header('Cache-Control','private, no-store')
  list(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string, @Param('invoiceId',ParseUUIDPipe) invoice: string) {
    const p = manager(request);
    return this.database.tenantReadTransaction(p.tenantId, async db => (await db.query(
      `SELECT verification_id AS id, received_on::text AS "receivedOn", amount::text, account_label AS account,
       reference, verified_at AS "verifiedAt", invoice_due_at_verification::text AS "invoiceDue",
       evidence_type IS NOT NULL AS "hasEvidence" FROM ${this.table}
       WHERE customer_id=$1 AND connection_id=$2 AND invoice_id=$3 ORDER BY verified_at DESC`,
      [p.tenantId,connection,invoice])).rows);
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
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:5242880, files:1, fields:4, fieldSize:600, parts:6}}))
  async verify(@Req() request: Request, @Param('connectionId',ParseUUIDPipe) connection: string,
    @Param('invoiceId',ParseUUIDPipe) invoice: string, @Headers('idempotency-key') key: string,
    @Body() body: unknown, @UploadedFile() file?: Evidence) {
    const p = manager(request);
    const parsed = fields.safeParse(body);
    if (!parsed.success || !z.uuid().safeParse(key).success) throw new BadRequestException('Check the receipt details.');
    const {receivedOn,amount,account,reference} = parsed.data;
    const type = receiptEvidenceType(file);
    const hash = createHash('sha256').update(JSON.stringify([connection,invoice,receivedOn,amount,account,reference,type]))
      .update(file?.buffer ?? '').digest('hex');
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(p.tenantId, async db => {
      const inserted = await db.query(`INSERT INTO ${this.table}
        (customer_id,connection_id,invoice_id,verification_id,verified_by,received_on,amount,account_label,reference,
         evidence,evidence_type,payload_hash,invoice_due_at_verification)
        SELECT i.customer_id,i.xero_connection_id,i.xero_invoice_id,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,i.amount_due
        FROM ${schema}.student_operations_xero_invoices i JOIN ${schema}.student_operations_xero_sync_configurations c
          USING (customer_id,xero_connection_id)
        WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_invoice_id=$3
          AND c.enabled AND c.organisation_role='trust' AND i.currency_code='AUD' AND i.invoice_type='ACCREC'
          AND i.invoice_status='AUTHORISED' AND i.amount_due>0 AND $6::date <= (now() AT TIME ZONE 'Australia/Brisbane')::date
        ON CONFLICT DO NOTHING RETURNING verification_id`,
        [p.tenantId,connection,invoice,key,p.identityUserId,receivedOn,amount,account,reference,file?.buffer??null,type,hash]);
      if (!inserted.rowCount) {
        const prior = await db.query(`SELECT payload_hash FROM ${this.table} WHERE customer_id=$1 AND verification_id=$2 AND verified_by=$3`,[p.tenantId,key,p.identityUserId]);
        if (prior.rows[0]?.payload_hash !== hash) throw new ConflictException('Review existing receipts, payment date and current TRUST invoice before saving.');
      }
      return {id:key};
    });
  }
}
