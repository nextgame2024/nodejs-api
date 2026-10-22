// Worker-only rollout control. Keep the existing budget unless explicitly
// configured; this never changes the durable daily counter/start timestamp.
export function studentDocumentFetchBudgetMinutes(env:NodeJS.ProcessEnv=process.env):number {
  const raw=env.STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES;
  if(raw===undefined) return 30;
  if(!/^[1-9]\d*$/.test(raw) || Number(raw)<30 || Number(raw)>120) {
    throw new Error('STUDENT_DOCUMENT_FETCH_BUDGET_MINUTES must be an integer from 30 to 120.');
  }
  const minutes=Number(raw);
  if(minutes>30) {
    const missing=['XERO_SHARED_QUOTA_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED']
      .filter(key=>env[key]!=='true');
    if(missing.length) throw new Error(`Extended document fetch budget requires protected source discovery. Missing or not exactly true: ${missing.join(', ')}.`);
  }
  return minutes;
}
