import {jest} from '@jest/globals';
import type {PoolClient} from 'pg';
import {studentNameKey,uniqueStudentMatch,linkStudentInvoice} from './student-invoice-matching.js';

describe('PTY student matching',()=>{
 const oldUrl=process.env.SOPHIA_RUNTIME_DATABASE_URL;
 beforeAll(()=>{process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://test:test@localhost/test';});
 afterAll(()=>{if(oldUrl)process.env.SOPHIA_RUNTIME_DATABASE_URL=oldUrl;else delete process.env.SOPHIA_RUNTIME_DATABASE_URL;});
 const students=[{user_id:'laura',name:'Laura Garcia Lopez'},{user_id:'nathalia',name:'Nathalia Fernanda Villamizar Calderon'}];
 test('removes repeated advisor/contact prefixes without changing real names',()=>{
  expect(uniqueStudentMatch('C30 Laura Garcia Lopez',students)).toBe('laura');
  expect(uniqueStudentMatch('s15 - s10 Nathalia Fernanda Villamizar Calderon',students)).toBe('nathalia');
  expect(studentNameKey('S15 – Laura Garcia Lopez')).toBe('laura garcia lopez');
  expect(studentNameKey('Carlos Garcia')).toBe('carlos garcia');
 });
 test('leaves missing and ambiguous names pending',()=>{
  expect(uniqueStudentMatch('C30 Laura Garcia',students)).toBeNull();
  expect(uniqueStudentMatch('C30 Laura Garcia Lopez',[...students,{user_id:'duplicate',name:'LAURA GARCIA LOPEZ'}])).toBeNull();
  expect(uniqueStudentMatch('C30 ',students)).toBeNull();
 });
 test('rejects students outside the tenant before any mutation',async()=>{
  const query=jest.fn<any>().mockResolvedValue({rows:[]});
  await expect(linkStudentInvoice({query} as unknown as PoolClient,'tenant','connection','invoice','foreign-user','actor')).rejects.toThrow('Select an available student');
  expect(query).toHaveBeenCalledTimes(1);expect(query.mock.calls[0][1]).toEqual(['tenant','foreign-user']);
 });
 test('never replaces an invoice already assigned to a different student',async()=>{
  const query=jest.fn<any>().mockResolvedValueOnce({rows:[{student_reference:'STD-1'}]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{student_id:'STD-2'}]});
  await expect(linkStudentInvoice({query} as unknown as PoolClient,'tenant','connection','invoice','user','actor')).rejects.toThrow('already linked to another student');
  expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
 });
});
