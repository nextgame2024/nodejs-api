import { z } from 'zod';

export const decimal4=z.string().regex(/^\d{1,8}(\.\d{1,4})?$/);
const text=z.string().max(4000),optional=text.nullish();
const number=z.union([z.number().finite(),decimal4]).nullish();
const details=z.object({UnitPrice:number,AccountCode:optional,TaxType:optional}).passthrough();
const items=z.array(z.object({ItemID:z.uuid(),Code:z.string().min(1).max(50),Name:optional,Description:optional,IsSold:z.boolean().optional(),SalesDetails:details.nullish()}).passthrough()).max(10000);
const accounts=z.array(z.object({Code:optional,Name:text,TaxType:optional,Status:optional}).passthrough()).max(10000);
const taxes=z.array(z.object({Name:text,TaxType:text,Status:optional,EffectiveRate:number,DisplayTaxRate:number,CanApplyToRevenue:z.boolean().optional()}).passthrough()).max(2000);
function decimal(value:unknown):string|null{
  if(value===null||value===undefined)return null;
  const result=String(value);return decimal4.safeParse(result).success?result:null;
}
export function parseSalesCatalogue(rawItems:unknown,rawAccounts:unknown,rawTaxRates:unknown){
  const parsedItems=items.parse(rawItems),parsedAccounts=accounts.parse(rawAccounts),parsedTaxes=taxes.parse(rawTaxRates);
  const salesAccounts=parsedAccounts.filter(a=>a.Code&&(!a.Status||a.Status==='ACTIVE')).map(a=>({code:a.Code!,name:a.Name,taxType:a.TaxType??null}));
  return {
    items:parsedItems.filter(i=>i.IsSold!==false).map(i=>({itemId:i.ItemID,code:i.Code,name:i.Name??i.Code,description:i.Description??'',
      unitPrice:decimal(i.SalesDetails?.UnitPrice),accountCode:i.SalesDetails?.AccountCode??null,
      taxType:i.SalesDetails?.TaxType??salesAccounts.find(a=>a.code===i.SalesDetails?.AccountCode)?.taxType??null})),
    accounts:salesAccounts,
    taxRates:parsedTaxes.filter(t=>(!t.Status||t.Status==='ACTIVE')&&t.CanApplyToRevenue!==false).map(t=>({taxType:t.TaxType,name:t.Name,rate:decimal(t.EffectiveRate)})),
  };
}
export type XeroSalesCatalogue=ReturnType<typeof parseSalesCatalogue>;
export function scaled4(value:string):bigint{const [whole,fraction='']=decimal4.parse(value).split('.');return BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));}
export function pricedLineMinor(quantity:string,price:string){return Number((scaled4(quantity)*scaled4(price)+500000n)/1000000n);}
export function lineTaxMinor(net:number,rate:string){return Number((BigInt(net)*scaled4(rate)+500000n)/1000000n);}
