import { z } from 'zod';

export const DOCUMENT_ANALYSIS_VERSION = '1';
export const documentKind = z.enum(['engagement_letter', 'passport', 'letter_of_offer']);
const text = z.string().trim().min(1).max(500);
const date = z.iso.date();
const money = z.number().int().min(0).max(1_000_000_000); // Minor currency units.
const evidence = z.array(z.object({ page: z.number().int().min(1).max(200), quote: text }).strict()).max(50);
const common = { studentName: text.nullable(), evidence, issues: z.array(text).max(30) };
export const engagementExtraction = z.object({
  kind: z.literal('engagement_letter'), ...common,
  status: z.enum(['signed', 'sent', 'viewed', 'unknown']),
  signerName: text.nullable(), signedAt: z.iso.datetime({ offset: true }).nullable(),
  completed: z.boolean(), documentIdMatches: z.boolean().nullable(),
}).strict();
export const passportExtraction = z.object({
  kind: z.literal('passport'), ...common, expiresOn: date.nullable(),
  mrzExpiryMatches: z.boolean().nullable(),
}).strict();
export const offerExtraction = z.object({
  kind: z.literal('letter_of_offer'), ...common,
  collegeName: text.nullable(), abn: text.nullable(), cricosProviderCode: text.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/), statedTotalMinor: money.nullable(),
  courses: z.array(z.object({ name: text, code: text.nullable(),
    startsOn: date.nullable(), endsOn: date.nullable(), duration: text.nullable() }).strict()).max(30),
  fees: z.array(z.object({ label: text, amountMinor: money,
    conditional: z.boolean(), condition: text.nullable() }).strict()).max(100),
  instalments: z.array(z.object({ sequence: z.number().int().positive(),
    dueTerm: text.nullable(), dueOn: date.nullable(), totalMinor: money,
    includedConditionalFeeMinor: money,
  }).strict()).max(200),
}).strict();
export const documentExtraction = z.discriminatedUnion('kind', [engagementExtraction, passportExtraction, offerExtraction]);
export type DocumentExtraction = z.infer<typeof documentExtraction>;
export type DocumentKind = z.infer<typeof documentKind>;
export type AnalysisVerdict = { status: 'passed' | 'needs_review' | 'invalid'; reasons: string[] };

/** A dedicated extraction capability: no conversation state, tools or database authority. */
export interface StudentDocumentExtractionProvider {
  extract(input: {
    kind: DocumentKind; bytes: Buffer; mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
    schemaVersion: string; signal: AbortSignal;
  }): Promise<{ extraction: unknown; provider: string; model: string;
    inputTokens: number; outputTokens: number }>;
}

// Review endpoints accept corrections, never client-supplied actor/company authority.
export const documentReview = z.object({
  resultId: z.uuid(), expectedReviewVersion: z.number().int().min(0),
  decision: z.enum(['confirmed', 'rejected']), reason: text,
  corrections: documentExtraction.nullable(),
}).strict();

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

/** Dates are supplied by the company-local clock, never inferred by the model. */
export function validateDocument(input: unknown, expectedName: string, today: string): AnalysisVerdict {
  const value = documentExtraction.parse(input);
  date.parse(today);
  const reasons: string[] = [...value.issues];
  if (!value.evidence.length) reasons.push('missing_evidence');
  if (!value.studentName || normalizedName(value.studentName) !== normalizedName(expectedName)) reasons.push('student_identity_needs_review');
  if (value.kind === 'passport') {
    if (!value.expiresOn) reasons.push('expiry_unreadable');
    if (value.mrzExpiryMatches === false) reasons.push('expiry_conflict');
    if (reasons.length) return { status: 'needs_review', reasons };
    return value.expiresOn! < today ? { status: 'invalid', reasons: ['passport_expired'] } : { status: 'passed', reasons: [] };
  }
  if (value.kind === 'engagement_letter') {
    if (value.status !== 'signed' || !value.completed || !value.signedAt || value.documentIdMatches !== true
      || !value.signerName || normalizedName(value.signerName) !== normalizedName(expectedName)) reasons.push('signature_evidence_needs_review');
    return { status: reasons.length ? 'needs_review' : 'passed', reasons };
  }
  if (!value.collegeName || !value.courses.length || !value.instalments.length) reasons.push('offer_incomplete');
  const sequences = new Set<number>();
  for (const item of value.instalments) {
    if (sequences.has(item.sequence)) reasons.push('duplicate_instalment');
    sequences.add(item.sequence);
    if (item.includedConditionalFeeMinor > item.totalMinor) reasons.push('conditional_fee_exceeds_payment');
    if (!item.dueOn) reasons.push('payment_date_needs_review');
  }
  // Financial proposals always require review before future invoice use.
  return { status: 'needs_review', reasons: [...new Set([...reasons, 'offer_confirmation_required'])] };
}

/** Explicit invoice choice; preserves source amounts, removes an included fee only once. */
export function paymentWithConditionalFee(sourceTotalMinor: number, includedFeeMinor: number,
  feeMinor: number, applies: boolean): number {
  money.parse(sourceTotalMinor); money.parse(includedFeeMinor); money.parse(feeMinor); z.boolean().parse(applies);
  if (includedFeeMinor > sourceTotalMinor || includedFeeMinor > feeMinor) throw new Error('Invalid conditional fee components');
  return money.parse(sourceTotalMinor - includedFeeMinor + (applies ? feeMinor : 0));
}
