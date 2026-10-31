/** Xero supports deletion before approval and voiding only without settlements. */
export function invoiceRemovalAction(invoice:{type:string;status:string;amountPaid:unknown;amountDue:unknown;total:unknown;amountCredited?:unknown}):'delete'|'void'|null{
  if(!['ACCREC','ACCPAY'].includes(invoice.type))return null;
  if(invoice.amountPaid==null||Number(invoice.amountPaid)!==0||Number(invoice.amountCredited??0)!==0)return null;
  if(['DRAFT','SUBMITTED'].includes(invoice.status))return 'delete';
  if(invoice.status==='AUTHORISED'&&invoice.total!==null&&invoice.amountDue!==null&&
    Number.isFinite(Number(invoice.total))&&Number(invoice.total)>0&&Number(invoice.amountDue)===Number(invoice.total))return 'void';
  return null;
}
