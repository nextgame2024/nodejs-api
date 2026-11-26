import {describe,it,expect} from '@jest/globals';
import {isOfferTuition} from './offer-tuition.js';
describe('offer tuition identification',()=>{
  const courses=[{name:'GENERAL ENGLISH (DAYTIME)'}];
  it('recognises a reviewed course title and its printed details',()=>{
    expect(isOfferTuition('General English (Daytime), Commences 23 Feb 2026 - Finishes 15 May 2026, Length 12 weeks, CRICOS 0101937',courses)).toBe(true);
    expect(isOfferTuition('General English (Daytime)',courses)).toBe(true);
    expect(isOfferTuition('Tuition Fee',[])).toBe(true);
  });
  it('does not infer tuition from unrelated courses or ancillary fees',()=>{
    for(const label of ['Enrolment fee 2026','Materials 1-23 weeks 2026','General English (Daytime) materials','General English (Evening)','Unknown fee'])expect(isOfferTuition(label,courses)).toBe(false);
  });
});
