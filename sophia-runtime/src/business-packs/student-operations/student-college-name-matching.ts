// Deterministic, indexed college-name matching. No provider calls or database I/O.
type Named={id:string;name:string;aliases?:string[]};
export type CollegeMatchContact=Named&{classification?:string|null;collegeId?:string|null};
type Match={contactId:string;collegeId:string;confidence:number;method:'normalised_name'|'distinctive_name'|'similar_name'};
const grammar=new Set(['and','of','the','for','at','in']);
const generic=new Set(['australia','australian','college','colleges','school','schools','institute','institutes','academy','university','international','education','training','technology','group','language','languages','english','business','learning','higher','vocational','centre','center']);
export function collegeNameAliases(tradingName:string|null|undefined,acronym:string|null|undefined){return [...new Set([tradingName??'',...(tradingName??'').split(/[;,|\n]/),acronym??''].map(v=>v.trim()).filter(Boolean))];}
export function normaliseCollegeName(name:string){
 return name.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
  .replace(/\s*(?:[-–—]\s*)?\b(?:no\s+main(?:\s+provider)?|main\s+prov(?:ider)?)\s*$/u,'')
  .replace(/\s*[-–—]\s*\d+(?:\s+(?:from|elicos|vet|main|no\s+main)\b.*)?\s*$/u,'').replace(/&/g,' and ').replace(/[’']/g,'')
  .replace(/[^a-z0-9]+/g,' ').trim()
  .replace(/(?:\s+(?:pty|proprietary|ltd|limited|inc|incorporated|llc|corp|corporation))+$/u,'')
  .split(/\s+/).filter(word=>word&&!grammar.has(word)).join(' ');
}
function grams(value:string){const set=new Set<string>();for(let i=0;i<value.length-2;i++)set.add(value.slice(i,i+3));return set;}
function dice(a:Set<string>,b:Set<string>){let shared=0;for(const token of a)if(b.has(token))shared++;return a.size+b.size?2*shared/(a.size+b.size):0;}
function similarity(a:string,b:string){
 if(a===b)return 1;const max=Math.max(a.length,b.length),limit=Math.floor(max*.16);
 if(!max||Math.abs(a.length-b.length)>limit)return 0;
 let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){
  const row=[i];let minimum=i;
  for(let j=1;j<=b.length;j++){const n=Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));row.push(n);minimum=Math.min(minimum,n);}
  if(minimum>limit)return 0;previous=row;
 }
 return 1-previous[b.length]/max;
}
function prepared(value:Named){const key=normaliseCollegeName(value.name),tokens=new Set(key.split(' ').filter(Boolean));return {...value,key,tokens,grams:grams(key)};}
export function planCollegeNameMatches(contacts:CollegeMatchContact[],colleges:Named[]){
 const seen=new Set<string>();
 const directory=colleges.flatMap(c=>[c.name,...c.aliases??[]].filter(Boolean).map(name=>prepared({id:c.id,name})))
  .filter(c=>{const key=`${c.id}:${c.key}`;if(!c.key||seen.has(key))return false;seen.add(key);return true;});
 const exact=new Map<string,typeof directory>(),index=new Map<string,Set<number>>();
 const distinctive=new Map<string,typeof directory>();
 const identityKey=(tokens:Set<string>)=>[...tokens].filter(t=>!generic.has(t)).sort().join(' ');
 directory.forEach((college,i)=>{
  exact.set(college.key,[...(exact.get(college.key)??[]),college]);
  const key=identityKey(college.tokens);if(key)distinctive.set(key,[...(distinctive.get(key)??[]),college]);
  for(const token of college.tokens)if(token.length>=3&&!generic.has(token)){const bucket=index.get(token)??new Set<number>();bucket.add(i);index.set(token,bucket);}
 });
 const proposals:Match[]=[];let compared=0;
 for(const contact of contacts){
  // Explicit review decisions are authoritative, including other/unresolved.
  if(contact.classification)continue;
  const current=prepared(contact);if(current.key.length<3)continue;
  const words=current.key.split(' '),variants=[current.key];
  // A full name with its own acronym repeated at either end is still the
  // same name (ATI Australasia Technology Institute / ... Education NCVE).
  if(words.length>2){
   const rest=words.slice(1);if(words[0]===rest.map(w=>w[0]).join(''))variants.push(rest.join(' '));
   const leading=words.slice(0,-1);if(words.at(-1)===leading.map(w=>w[0]).join(''))variants.push(leading.join(' '));
  }
  const direct=[...new Map(variants.flatMap(v=>exact.get(v)??[]).map(c=>[c.id,c])).values()];
  if(direct.length){if(direct.length===1)proposals.push({contactId:contact.id,collegeId:direct[0].id,confidence:1,method:'normalised_name'});continue;}
  if(current.key.length<6)continue;
  const identity=identityKey(current.tokens),distinct=[...new Map((distinctive.get(identity)??[]).map(c=>[c.id,c])).values()];
  if(identity&&distinct.length===1){
   const tokens=identity.split(' ');let possible:Set<string>|undefined;
   for(const token of tokens){const ids=new Set([...(index.get(token)??[])].map(i=>directory[i].id));possible=possible?new Set([...possible].filter(id=>ids.has(id))):ids;}
   // A brand/signature must identify only one college anywhere in the alias
   // directory, not merely be the best of several similarly named colleges.
   if(possible?.size===1&&possible.has(distinct[0].id)){proposals.push({contactId:contact.id,collegeId:distinct[0].id,confidence:.95,method:'distinctive_name'});continue;}
  }
  const pool=new Set<number>();
  for(const token of current.tokens){for(const i of index.get(token)??[])pool.add(i);if(pool.size>128)break;}
  if(!pool.size||pool.size>128)continue;
  // Several legal/trading aliases for the same college are one candidate, not
  // competing colleges. Keep the strongest alias for each identity.
  const byCollege=new Map<string,{college:typeof directory[number];score:number}>();
  for(const i of pool){const college=directory[i],score=dice(current.grams,college.grams);if(score>=.8&&score>(byCollege.get(college.id)?.score??0))byCollege.set(college.id,{college,score});}
  const shortlist=[...byCollege.values()].sort((a,b)=>b.score-a.score||a.college.id.localeCompare(b.college.id)).slice(0,12);
  const scores=shortlist.map(({college})=>{compared++;return {college,score:.75*similarity(current.key,college.key)+.25*dice(current.tokens,college.tokens)};}).sort((a,b)=>b.score-a.score||a.college.id.localeCompare(b.college.id));
  const best=scores[0],second=scores[1];
  if(!best||best.score<.9||second&&best.score-second.score<.08)continue;
  proposals.push({contactId:contact.id,collegeId:best.college.id,confidence:Math.round(best.score*10000)/10000,method:'similar_name'});
 }
 // Historical numbered contacts may belong to the same college. Mapping their
 // identity does not choose one as the recipient for future commission invoices.
 const matches=proposals;
 return {matches,unresolved:contacts.filter(c=>!c.classification).length-matches.length,compared};
}
