import { invoiceRemovalAction } from './student-invoice-removal-policy.js';
describe('Invoice removal eligibility',()=>{
  const invoice={type:'ACCREC',status:'DRAFT',amountPaid:0,amountDue:100,total:100};
  test.each([['DRAFT','delete'],['SUBMITTED','delete'],['AUTHORISED','void'],['PAID',null],['VOIDED',null],['DELETED',null]])('%s supports %s', (status,action)=>{
    expect(invoiceRemovalAction({...invoice,status})).toBe(action);
  });
  test('settlements, unknown amounts, and non-invoice transactions cannot be removed',()=>{
    for(const change of [{amountPaid:10},{amountCredited:10},{amountPaid:undefined},{amountPaid:null},{type:'ACCRECCREDIT'},
      {status:'AUTHORISED',amountDue:80},{status:'AUTHORISED',amountDue:undefined}])expect(invoiceRemovalAction({...invoice,...change})).toBeNull();
  });
});
