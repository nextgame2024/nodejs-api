import {describe,it,expect} from '@jest/globals';
import {normaliseCollegeName,planCollegeNameMatches,collegeNameAliases} from './student-college-name-matching.js';
const college={id:'college',name:'Australian College of Commerce & Information Technology Pty Ltd'};
describe('PTY college name matching',()=>{
 it('matches the confirmed case despite and/&, legal suffixes and client numbering',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'Australian College of Commerce and Information Technology - 2'}],[college]).matches).toEqual([{contactId:'contact',collegeId:'college',confidence:1,method:'normalised_name'}]);
 });
 it('matches against the trading name when the legal name is completely different',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'English Unlimited - 2'}],[{id:'college',name:'Example Education Holdings Pty Ltd',aliases:['English Unlimited']}]).matches[0]).toMatchObject({contactId:'contact',collegeId:'college',confidence:1});
 });
 it('uses each stored trading name in comma/semicolon separated lists',()=>{
  const aliases=collegeNameAliases('Albright Institute of Business and Language; Albright Institute of English, Albright College','ALB');
  expect(planCollegeNameMatches([{id:'contact',name:'Albright Institute Business and Language - 2'}],[{id:'college',name:'ANIT Australia Pty Ltd',aliases}]).matches[0]?.collegeId).toBe('college');
 });
 it('recognises a repeated acronym alongside its full legal/trading name',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'ATI AUSTRALASIA TECHNOLOGY INSTITUTE - 1'}],[{id:'college',name:'Australian International Education Centre Pty Ltd',aliases:['Australasia Technology Institute']}]).matches[0]?.collegeId).toBe('college');
  expect(planCollegeNameMatches([{id:'contact',name:'National College of Vocational Education NCVE - 2 NO MAIN'}],[{id:'college',name:'National College of Vocational Education Pty Ltd'}]).matches[0]?.collegeId).toBe('college');
 });
 it('recognises a unique distinctive brand despite generic education/country descriptors',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'ILSC Language Schools - MAIN PROV'}],[{id:'college',name:'ILSC (Brisbane) Pty Ltd',aliases:['ILSC']}]).matches[0]).toMatchObject({collegeId:'college',method:'distinctive_name'});
  expect(planCollegeNameMatches([{id:'contact',name:'Torrens University - 1'}],[{id:'college',name:'Torrens University Australia Limited'}]).matches[0]?.collegeId).toBe('college');
 });
 it('does not use a distinctive brand shared by another college or generic words alone',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'Example Institute - 1'}],[{id:'a',name:'Example College Australia'},{id:'b',name:'Example Specialist College'}]).matches).toHaveLength(0);
  expect(planCollegeNameMatches([{id:'contact',name:'Australian International College'}],[{id:'a',name:'Australian International Education College Pty Ltd'}]).matches).toHaveLength(0);
 });
 it('supports a unique stored acronym but does not guess an unstored acronym',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'ACIT - 2'}],[{...college,aliases:['ACIT']}]).matches[0]?.collegeId).toBe('college');
  expect(planCollegeNameMatches([{id:'contact',name:'ACIT - 2'}],[college]).matches).toHaveLength(0);
 });
 it('deduplicates aliases belonging to one college but rejects aliases shared by different colleges',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'Example College - 2'}],[{id:'a',name:'Example College Pty Ltd',aliases:['Example College','Example College Ltd']}]).matches).toHaveLength(1);
  expect(planCollegeNameMatches([{id:'contact',name:'Example College - 2'}],[{id:'a',name:'Legal One Ltd',aliases:['Example College']},{id:'b',name:'Legal Two Ltd',aliases:['Example College']}]).matches).toHaveLength(0);
 });
 it('does not count alternative aliases for the same college as a fuzzy ambiguity',()=>{
  const r=planCollegeNameMatches([{id:'contact',name:'Australian College of Commerce and Information Technlogy - 2'}],[{...college,aliases:['Australian College of Commerce and Information Technology']}]);
  expect(r.matches[0]?.collegeId).toBe('college');
 });
 it.each([' - 1',' - 12',' – 3',' — 4'])('ignores only the trailing client number %s',suffix=>{expect(normaliseCollegeName('Fixture College Pty. Ltd.'+suffix)).toBe('fixture college');});
 it('handles case, diacritics, punctuation and legal abbreviations',()=>{expect(normaliseCollegeName('Éxample & Sons College Proprietary Limited - 2')).toBe(normaliseCollegeName('Example and Sons College Pty Ltd'));});
 it('retains numbers inside a legal name',()=>{expect(normaliseCollegeName('College 123 Pty Ltd - 2')).toBe('college 123');});
 it('accepts a unique highly similar long name with a small typo',()=>{
  const result=planCollegeNameMatches([{id:'contact',name:'Australian College of Commerce and Information Technlogy - 2'}],[college]);
  expect(result.matches[0]).toMatchObject({collegeId:'college',method:'similar_name'});expect(result.matches[0].confidence).toBeGreaterThanOrEqual(.9);
 });
 it('leaves a short acronym or weak name overlap pending',()=>{
  expect(planCollegeNameMatches([{id:'short',name:'ACIT - 2'},{id:'other',name:'Australian College of Business - 3'}],[college]).matches).toHaveLength(0);
 });
 it('leaves duplicate directory names and close alternatives pending',()=>{
  expect(planCollegeNameMatches([{id:'contact',name:'Example College - 2'}],[{id:'a',name:'Example College Pty Ltd'},{id:'b',name:'Example College Limited'}]).matches).toHaveLength(0);
  expect(planCollegeNameMatches([{id:'contact',name:'Australian College of Commerce and Information Technlogy'}],[college,{id:'other',name:'Australian College of Commerce & Information Technologies'}]).matches).toHaveLength(0);
 });
 it('links numbered historical contacts to the same unique college identity',()=>{
  expect(planCollegeNameMatches([{id:'one',name:college.name+' - 1'},{id:'two',name:college.name+' - 2'}],[college]).matches).toHaveLength(2);
 });
 it('preserves confirmed, other and deliberately unresolved decisions',()=>{
  expect(planCollegeNameMatches([{id:'one',name:college.name,classification:'college',collegeId:'college'},{id:'two',name:college.name+' - 2'},{id:'three',name:'Example College',classification:'other'},{id:'four',name:'Another College',classification:'unresolved'}],[college,{id:'c',name:'Example College'},{id:'d',name:'Another College'}]).matches).toEqual([{contactId:'two',collegeId:'college',confidence:1,method:'normalised_name'}]);
 });
 it.each([' - MAIN PROV',' MAIN PROV',' - 2 NO MAIN',' No main provider',' - 1 from 1st july 2024 ELICOS & VET'])('ignores the client provider annotation %s',suffix=>{
  expect(planCollegeNameMatches([{id:'contact',name:'Greenwich College'+suffix}],[{id:'college',name:'Greenwich College Pty Ltd'}]).matches[0]?.collegeId).toBe('college');
 });
 it('avoids a full contacts-by-directory edit-distance scan at directory scale',()=>{
  const colleges=Array.from({length:1543},(_,i)=>({id:`college-${i}`,name:`Brand${i} Education College Pty Ltd`}));
  const contacts=colleges.map((c,i)=>({id:`contact-${i}`,name:c.name+' - 2'}));
  const result=planCollegeNameMatches(contacts,colleges);expect(result.matches).toHaveLength(1543);expect(result.compared).toBe(0);
 });
});
