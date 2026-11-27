import {describe, expect, it, jest} from '@jest/globals';
import {BadRequestException, ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {TrustReceiptsController, receiptEvidenceType} from './trust-receipts.controller.js';

describe('TRUST verification intake', () => {
  const tx = jest.fn();
  const controller = new TrustReceiptsController({tenantTransaction:tx} as never);
  const input = {receivedOn:'2026-11-13',amount:'2742.00',account:'Fixture TRUST',reference:''};
  const request = (role:string) => ({studentOperationsPrincipal:{role}} as never);

  it('requires the manager role before processing receipt data', async () => {
    await expect(controller.verify(request('advisor'),randomUUID(),randomUUID(),randomUUID(),input)).rejects.toThrow(ForbiddenException);
    expect(tx).not.toHaveBeenCalled();
  });

  it.each(['0','-12','1.234','0.00001','2e4'])('rejects invalid receipt amount %s', async amount => {
    await expect(controller.verify(request('chief_executive'),randomUUID(),randomUUID(),randomUUID(),{...input,amount})).rejects.toThrow(BadRequestException);
    expect(tx).not.toHaveBeenCalled();
  });

  it('accepts form-only verification and rejects a mislabeled screenshot', () => {
    expect(receiptEvidenceType()).toBeNull();
    expect(() => receiptEvidenceType({mimetype:'image/png',buffer:Buffer.from('<html>')})).toThrow(BadRequestException);
  });
});
