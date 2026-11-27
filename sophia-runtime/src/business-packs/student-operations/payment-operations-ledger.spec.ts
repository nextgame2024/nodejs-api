import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

const ledger = JSON.parse(readFileSync(new URL('./fixtures/payment-operations-ledger.json', import.meta.url), 'utf8'));

describe('synthetic payment operations acceptance ledger', () => {
  it('uses synthetic source and document identifiers for every review case', () => {
    for (const name of ['partial', 'direct', 'beforeFeed', 'payout', 'excess']) {
      const row = ledger[name];
      expect(row.owner).toBeTruthy();
      expect(row.trigger).toBeTruthy();
      expect(row.source).toMatch(/^demo-/);
      expect(ledger.sources[row.source]).toBeTruthy();
      expect(row.date ?? row.observations[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(ledger.partial.invoiceNumber).toMatch(/^DEMO-/);
    for (const observation of ledger.beforeFeed.observations) expect(observation.movement).toMatch(/^demo-/);
  });

  it('keeps the materials balance open after a tuition receipt', () => {
    const row = ledger.partial;
    expect(row.received).toBe(row.tuition);
    expect(row.tuition + row.materials - row.received).toBe(row.expectedInvoiceBalance);
    expect(row.expectedPtyCash).toBe(0);
  });

  it('keeps the PTY commission open after a direct college payment', () => {
    const row = ledger.direct;
    expect(row.confirmedCollegeReceipt).toBeGreaterThan(0);
    expect(row.expectedTrustCash).toBe(0);
    expect(row.expectedPtyCash).toBe(0);
    expect(row.commissionInvoice.amountDue - row.expectedPtyCash).toBe(row.expectedPtyBalance);
    expect(row.commissionInvoice.invoiceNumber).toBe(ledger.partial.invoiceNumber);
    expect(row.commissionInvoice.source).not.toBe(ledger.partial.source);
  });

  it('counts the Monday deposit once across both observations', () => {
    const row = ledger.beforeFeed;
    const movements = new Map<string, number>();
    for (const observation of row.observations) {
      const original = movements.get(observation.movement);
      if (original !== undefined) expect(observation.amount).toBe(original);
      movements.set(observation.movement, observation.amount);
    }
    expect(movements.size).toBe(row.expectedDistinctReceipts);
    expect([...movements.values()].reduce((sum, amount) => sum + amount, 0)).toBe(row.expectedTrustCash);
    expect(row.expectedPtyCash).toBe(0);
  });

  it('ties the payout to charges, fees and refunds', () => {
    const row = ledger.payout;
    const members: number[] = [...row.charges, ...row.fees, ...row.refunds];
    expect(members.reduce((sum, amount) => sum + amount, 0)).toBe(row.expectedBankDeposit);
    expect(row.expectedAdditionalSalesFromPayout).toBe(0);
  });

  it('preserves the student credit separately from the invoice allocation', () => {
    const row = ledger.excess;
    expect(Math.min(row.invoiceDue, row.received)).toBe(row.expectedInvoiceAllocation);
    expect(row.received - row.expectedInvoiceAllocation).toBe(row.expectedUnallocatedCredit);
    expect(row.expectedPtyCash).toBe(0);
  });
});
