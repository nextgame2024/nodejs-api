import { documentExtraction, documentReview, paymentWithConditionalFee, validateDocument } from './student-document-analysis.contracts.js';

const base = { studentName: 'Example Student', evidence: [{ page: 1, quote: 'Relevant source evidence' }], issues: [] };
const passport = { ...base, kind: 'passport', expiresOn: '2035-08-06', mrzExpiryMatches: true };
const engagement = { ...base, kind: 'engagement_letter', status: 'signed', signerName: 'Example Student',
  signedAt: '2026-09-15T02:59:31Z', completed: true, documentIdMatches: true };
describe('Document extraction and deterministic validation contracts', () => {
  test('expiry changes with current date without another extraction and includes expiry day', () => {
    expect(validateDocument(passport, 'Example Student', '2035-08-06').status).toBe('passed');
    expect(validateDocument(passport, 'Example Student', '2035-08-07')).toEqual({ status: 'invalid', reasons: ['passport_expired'] });
  });
  test.each([{ expiresOn: null }, { mrzExpiryMatches: false }, { studentName: 'Other Person' }, { evidence: [] }])('ambiguous passports require review: %j', change => {
    expect(validateDocument({ ...passport, ...change }, 'Example Student', '2026-10-25').status).toBe('needs_review');
  });
  test('rejects malformed dates and unexpected sensitive fields', () => {
    expect(() => documentExtraction.parse({ ...passport, expiresOn: '2026-02-30' })).toThrow();
    expect(() => documentExtraction.parse({ ...passport, passportNumber: 'not-retained' })).toThrow();
  });
  test('signature evidence needs completion, document correlation and matching signer', () => {
    expect(validateDocument(engagement, 'Example Student', '2026-10-25').status).toBe('passed');
    for (const change of [{ status: 'viewed' }, { completed: false }, { signerName: 'Other Person' }, { documentIdMatches: null }, { signedAt: null }]) {
      expect(validateDocument({ ...engagement, ...change }, 'Example Student', '2026-10-25').status).toBe('needs_review');
    }
  });
  test('offers preserve literal due terms and conditional fee amounts for review', () => {
    const offer = { ...base, kind: 'letter_of_offer', collegeName: 'Example College', abn: null, cricosProviderCode: null,
      currency: 'AUD', statedTotalMinor: 904000, courses: [{ name: 'General English', code: null, startsOn: null, endsOn: null, duration: '60 weeks' }],
      fees: [{ label: 'Transfer fee', amountMinor: 2500, conditional: true, condition: 'International payments' }],
      instalments: [{ sequence: 1, dueTerm: 'Immediately', dueOn: null, totalMinor: 99500, includedConditionalFeeMinor: 2500 }] };
    expect(validateDocument(offer, 'Example Student', '2026-10-25')).toEqual({ status: 'needs_review', reasons: ['payment_date_needs_review', 'offer_confirmation_required'] });
    expect(offer.instalments[0].dueOn).toBeNull();
    expect(offer.statedTotalMinor).toBe(904000);
  });
  test('explicit fee decision includes or excludes exactly once', () => {
    expect(paymentWithConditionalFee(99500, 2500, 2500, true)).toBe(99500);
    expect(paymentWithConditionalFee(99500, 2500, 2500, false)).toBe(97000);
    expect(paymentWithConditionalFee(97000, 0, 2500, true)).toBe(99500);
    expect(paymentWithConditionalFee(97000, 0, 2500, false)).toBe(97000);
    expect(() => paymentWithConditionalFee(99500, 2500, 2500, undefined as unknown as boolean)).toThrow();
    expect(() => paymentWithConditionalFee(100, 2500, 2500, false)).toThrow();
  });
  test('review cannot spoof authority or omit optimistic version', () => {
    expect(() => documentReview.parse({ resultId: '11111111-1111-4111-8111-111111111111', decision: 'confirmed', reason: 'Reviewed', corrections: null })).toThrow();
    expect(() => documentReview.parse({ resultId: '11111111-1111-4111-8111-111111111111', expectedReviewVersion: 0, decision: 'confirmed', reason: 'Reviewed', corrections: null, actor: 'SophiaAi' })).toThrow();
  });
  test('review note is optional and normalizes an omitted note to null', () => {
    const review = { resultId: '11111111-1111-4111-8111-111111111111', expectedReviewVersion: 0, decision: 'confirmed' as const, corrections: null };
    expect(documentReview.parse(review).reason).toBeNull();
    expect(documentReview.parse({ ...review, reason: null }).reason).toBeNull();
    expect(documentReview.parse({ ...review, reason: 'Useful context' }).reason).toBe('Useful context');
    expect(documentReview.parse({ ...review, reason: '   ' }).reason).toBeNull();
  });
});
