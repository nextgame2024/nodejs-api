/** Recognise explicit tuition labels or the reviewed course title, without treating other fees as tuition. */
export function isOfferTuition(label:string,courses:readonly {name:string}[]):boolean {
  if(/tuition/i.test(label))return true;
  if(/\b(enrol(?:ment|lment)?|materials?|visa|oshc|insurance|transfer|discount|application)\b/i.test(label))return false;
  const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const value=normalize(label);
  return courses.some(course=>{const name=normalize(course.name);return !!name&&(value===name||value.startsWith(name+' commences ')||value.startsWith(name+' starts ')||value.startsWith(name+' length ')||value.startsWith(name+' cricos '));});
}
