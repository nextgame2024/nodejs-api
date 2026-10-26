import { describe,expect,it } from '@jest/globals';
import { parseSalesCatalogue,pricedLineMinor,lineTaxMinor } from './xero-sales-catalogue.js';
describe('Xero sales catalogue defaults',()=>{
  it('preserves four-decimal prices and rounds only after multiplying quantities',()=>{
    expect(pricedLineMinor('3','0.3333')).toBe(100);expect(pricedLineMinor('4','180.0000')).toBe(72000);expect(lineTaxMinor(97000,'10')).toBe(9700);expect(lineTaxMinor(12345,'0')).toBe(0);
  });
  it('uses the item tax override, otherwise the account default; unknown rates stay unknown',()=>{
    const fixture={ItemID:'11111111-1111-4111-8111-111111111111',Code:'Course',SalesDetails:{UnitPrice:180,AccountCode:'812'}};
    const parsed=parseSalesCatalogue([fixture],[{Code:'812',Name:'Tuition',TaxType:'NONE',Status:'ACTIVE'}],[{Name:'Unknown',TaxType:'NONE',Status:'ACTIVE',DisplayTaxRate:0}]);
    expect(parsed.items[0].taxType).toBe('NONE');expect(parsed.taxRates[0].rate).toBeNull();
    expect(parseSalesCatalogue([{...fixture,SalesDetails:{...fixture.SalesDetails,TaxType:'OUTPUT'}}],[{Code:'812',Name:'Tuition',TaxType:'NONE'}],[]).items[0].taxType).toBe('OUTPUT');
  });
});
