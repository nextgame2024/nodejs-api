// Versioned, declarative configuration. Spreadsheet prose is never executable.
export function validateCommissionConfiguration(input) {
  if (input == null) return null;
  const fail = () => { throw new Error('Enter a valid version 2 commission configuration.'); };
  const keys = ['eligibilityNote','maxTrimester','label','choiceRequired','benefits','version','state','blockedReason','city','effectiveFrom','effectiveTo','dateBasis','rateNumerator','rateDenominator','rateMethod','laterRateNumerator','nonBulkOnly','cashback'];
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) || input.version !== 2) fail();
  const v = structuredClone(input);
  if(v.eligibilityNote!==undefined&&(typeof v.eligibilityNote!=='string'||!v.eligibilityNote.trim()||v.eligibilityNote.length>2000))fail();
  if(v.maxTrimester!==undefined&&(!Number.isSafeInteger(v.maxTrimester)||v.maxTrimester<1||v.maxTrimester>100))fail();
  if(v.label!==undefined&&(typeof v.label!=='string'||!v.label.trim()||v.label.length>300))fail();
  if(v.choiceRequired!==undefined&&typeof v.choiceRequired!=='boolean')fail();
  if (!['ready','blocked'].includes(v.state) || !['fixed','trimester','first_month'].includes(v.rateMethod) || typeof v.nonBulkOnly !== 'boolean') fail();
  for (const field of ['city','blockedReason']) {
    if (v[field] != null && (typeof v[field] !== 'string' || v[field].length > (field === 'city' ? 200 : 4000))) fail();
    v[field] = v[field]?.normalize('NFKC').trim() || null;
  }
  if ((v.state === 'blocked') !== Boolean(v.blockedReason)) fail();
  for (const field of ['effectiveFrom','effectiveTo']) {
    if (v[field] != null && (!/^\d{4}-\d{2}-\d{2}$/.test(v[field]) || !Number.isFinite(Date.parse(v[field])) || new Date(v[field]).toISOString().slice(0,10) !== v[field])) fail();
    v[field] ??= null;
  }
  if (v.effectiveFrom && v.effectiveTo && v.effectiveFrom > v.effectiveTo) fail();
  if (!['enrolment_date',null].includes(v.dateBasis) || Boolean(v.effectiveFrom || v.effectiveTo) !== Boolean(v.dateBasis)) fail();
  if (!Number.isSafeInteger(v.rateNumerator) || !Number.isSafeInteger(v.rateDenominator) || v.rateNumerator < 0 || v.rateDenominator < 1 || v.rateNumerator > v.rateDenominator || v.rateDenominator > 1000000) fail();
  if (!Number.isSafeInteger(v.laterRateNumerator) || v.laterRateNumerator < 0 || v.laterRateNumerator > v.rateDenominator) fail();
  if (v.rateMethod !== 'first_month' && v.laterRateNumerator !== 0 || v.rateMethod === 'trimester' && v.rateNumerator * 5 !== v.rateDenominator) fail();
  const c = v.cashback;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['mode','amountMinor'].includes(k)) || !['none','enrolment_gross','fixed_net'].includes(c.mode) || !Number.isSafeInteger(c.amountMinor) || c.amountMinor < 0 || c.amountMinor > 1000000000 || (c.mode !== 'fixed_net' && c.amountMinor !== 0) || (c.mode === 'fixed_net' && c.amountMinor === 0)) fail();
  if(v.benefits!==undefined){
    if(!Array.isArray(v.benefits)||v.benefits.length>2)fail();
    const sources=new Set();
    for(const b of v.benefits){
      if(!b||typeof b!=='object'||Object.keys(b).some(k=>!['fixedAmountMinor','classification','source','percentageBasisPoints','gstInclusive','itemCode','saleName','advisorName'].includes(k))||!['enrolment','materials'].includes(b.source)||sources.has(b.source)||b.source==='enrolment'&&c.mode!=='none')fail();
      sources.add(b.source);
      if(b.fixedAmountMinor!==undefined&&(!Number.isSafeInteger(b.fixedAmountMinor)||b.fixedAmountMinor<1||b.fixedAmountMinor>1000000000))fail();
      if(b.classification!==undefined&&!['ELICOS','VET','HE'].includes(b.classification))fail();
      if(!Number.isSafeInteger(b.percentageBasisPoints)||b.percentageBasisPoints<1||b.percentageBasisPoints>10000||typeof b.gstInclusive!=='boolean')fail();
      for(const key of ['itemCode','saleName','advisorName']){if(key==='advisorName'&&b[key]===null)continue;if(typeof b[key]!=='string'||!b[key].trim()||b[key].length>(key==='advisorName'?200:100))fail();b[key]=b[key].trim();}
    }
  }
  return v;
}

export function commissionConditionsOverlap(a, b) {
  if(a.configuration?.label&&b.configuration?.label&&a.configuration.label!==b.configuration.label)return false;
  const normal = v => String(v ?? '').normalize('NFKC').trim().toLowerCase();
  const ac = a.configuration, bc = b.configuration;
  const predicates = r => [r.classification,r.location,r.program,r.configuration?.city];
  const av = predicates(a), bv = predicates(b);
  if (av.some((v,i) => v && bv[i] && normal(v) !== normal(bv[i]))) return false;
  const start = c => c?.effectiveFrom ?? '0001-01-01', end = c => c?.effectiveTo ?? '9999-12-31';
  if (start(ac) > end(bc) || start(bc) > end(ac)) return false;
  // A general rule can be a fallback only when one rule logically contains the other.
  const narrower = (x,y,xc,yc) => y.every((v,i) => !v || normal(v) === normal(x[i])) && start(xc) >= start(yc) && end(xc) <= end(yc);
  const ab = narrower(av,bv,ac,bc), ba = narrower(bv,av,bc,ac);
  return ab === ba; // equivalent or incomparable overlapping conditions are ambiguous
}
