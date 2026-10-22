import { studentDocumentFetchBudgetMinutes as budget } from './student-document-fetch-budget.js';

const protectedEnv={XERO_SHARED_QUOTA_ENABLED:'true',XERO_SHARED_BACKOFF_ENABLED:'true',STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED:'true'};
it('preserves the default 30-minute budget without enabling new protections',()=>{
  expect(budget({})).toBe(30);
  expect(budget({STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES:'30'})).toBe(30);
});
it.each(['31','60','90','120'])('allows an explicitly protected %s-minute budget',minutes=>{
  expect(budget({...protectedEnv,STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES:minutes})).toBe(Number(minutes));
});
it.each(['','0','29','121','999999999999999999999','NaN','Infinity','30.5',' 120 ','0120','1e2','120 minutes'])
  ('rejects malformed/out-of-range input without echoing it (%s)',minutes=>{
    expect(()=>budget({...protectedEnv,STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES:minutes}))
      .toThrow('STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES must be an integer from 30 to 120.');
  });
it.each(Object.keys(protectedEnv))('requires %s before widening the budget',key=>{
  for(const value of [undefined,'false','TRUE',' true ']) {
    expect(()=>budget({...protectedEnv,[key]:value,STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES:'120'})).toThrow(key);
  }
});
