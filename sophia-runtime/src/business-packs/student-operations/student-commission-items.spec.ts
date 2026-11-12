import {describe,it,expect} from '@jest/globals';
import {commissionTuitionItemCode} from './student-commission-items.js';
describe('PTY tuition item identity',()=>{
 it('uses the tuition code while ignoring fees and zero-valued lines',()=>{
  expect(commissionTuitionItemCode([{kind:'tuition',amountMinor:100,itemCode:' ELICOS ON-SHORE '},{kind:'materials',amountMinor:20,itemCode:'Materials'},{kind:'tuition',amountMinor:0,itemCode:'VET'}])).toBe('elicos on-shore');
 });
 it('accepts several tuition lines only when they share the same code',()=>{
  expect(commissionTuitionItemCode([{kind:'tuition',amountMinor:100,itemCode:'VET'},{kind:'tuition',amountMinor:200,itemCode:'vet'}])).toBe('vet');
  expect(()=>commissionTuitionItemCode([{kind:'tuition',amountMinor:100,itemCode:'ELICOS'},{kind:'tuition',amountMinor:200,itemCode:'VET'}])).toThrow('one tuition item');
 });
 it('rejects an absent or incomplete tuition selection',()=>{
  for(const lines of [[],[{kind:'other',amountMinor:100,itemCode:'Fee'}],[{kind:'tuition',amountMinor:100}]])expect(()=>commissionTuitionItemCode(lines)).toThrow('Select a tuition item');
 });
});
