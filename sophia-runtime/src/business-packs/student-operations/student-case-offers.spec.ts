import {matchOfferColleges,offerTotals,offerConfirmationProblems,type OfferExtraction} from './student-case-offers.js';
const colleges=[{collegeId:'a',name:'East Coast College',abn:'11627536823'},{collegeId:'b',name:'East Coast Institute',abn:null}];
export const sampleOffer:OfferExtraction={kind:'letter_of_offer',studentName:'Example Student',collegeName:'East Coast College',abn:'11627536823',cricosProviderCode:'03829G',currency:'AUD',statedTotalMinor:904000,
  studentSigned:true,studentSignerName:'Example Student',studentSignedOn:'2026-09-16',collegeSigned:true,
  evidence:[{page:2,quote:'Grand Total $9040.00'},{page:3,quote:'First payment $995.00 includes transfer fee'}],issues:[],
  courses:[{name:'General English',code:'116682E',startsOn:'2027-01-25',endsOn:'2028-03-19',duration:'60 weeks'}],
  fees:[{label:'Tuition',amountMinor:864000,conditional:false,condition:null},{label:'Enrolment',amountMinor:20000,conditional:false,condition:null},{label:'Material',amountMinor:20000,conditional:false,condition:null},{label:'International transfer fee',amountMinor:2500,conditional:true,condition:'International payments only'}],
  instalments:[{sequence:1,dueTerm:'Immediately',dueOn:null,totalMinor:99500,includedConditionalFeeMinor:2500},{sequence:2,dueTerm:null,dueOn:'2028-01-31',totalMinor:807000,includedConditionalFeeMinor:0}]};
describe('Offer matching and totals',()=>{
  test('unique normalized exact names qualify, partial names do not auto-select',()=>{
    expect(matchOfferColleges(' EAST  COAST COLLEGE ',null,colleges)).toMatchObject({resolution:'exact',exactCollegeId:'a'});
    expect(matchOfferColleges('East Coast',null,colleges)).toMatchObject({resolution:'partial',exactCollegeId:null});
    expect(matchOfferColleges('Unrelated Academy',null,colleges)).toMatchObject({resolution:'none',exactCollegeId:null});
  });
  test('duplicate names and conflicting identifiers require user choice',()=>{
    expect(matchOfferColleges('East Coast College','99999999999',colleges)).toMatchObject({resolution:'identifier_conflict',exactCollegeId:null});
    expect(matchOfferColleges('East Coast College',null,[...colleges,{...colleges[0],collegeId:'c'}])).toMatchObject({resolution:'multiple_exact',exactCollegeId:null});
  });
  test('preserves both totals and conditional inclusion without deciding applicability',()=>{
    expect(offerTotals(sampleOffer)).toEqual({statedTotalMinor:904000,instalmentTotalMinor:906500,includedConditionalFeesMinor:2500,baseInstalmentTotalMinor:904000,unexplainedDifference:false});
    expect(sampleOffer.instalments[0].dueOn).toBeNull();expect(offerConfirmationProblems(sampleOffer)).toEqual([]);
    expect(offerTotals({...sampleOffer,statedTotalMinor:910000}).unexplainedDifference).toBe(true);
  });
  test('requires usable courses, unique instalments, valid date order and fee components',()=>{
    expect(offerConfirmationProblems({...sampleOffer,courses:[{...sampleOffer.courses[0],endsOn:'2020-01-01'}]})).toContain('Course end dates must follow their start dates.');
    expect(offerConfirmationProblems({...sampleOffer,instalments:[sampleOffer.instalments[0],sampleOffer.instalments[0]]})).toContain('Each instalment needs a unique number.');
    expect(offerConfirmationProblems({...sampleOffer,instalments:[{...sampleOffer.instalments[0],includedConditionalFeeMinor:100000}]})).toContain('The included conditional fee cannot exceed its payment.');
    expect(offerConfirmationProblems({...sampleOffer,studentSigned:false})).toContain('Confirm that the student signed the Letter of Offer.');
    expect(offerConfirmationProblems({...sampleOffer,studentSignerName:'Other Person'})).toContain('Confirm the Letter of Offer signer matches the student.');
  });
});
