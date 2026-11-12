// Item IDs belong to an organisation. Only an unambiguous tuition item code
// can identify the corresponding item in the separate PTY catalogue.
export function commissionTuitionItemCode(lines:ReadonlyArray<{kind?:unknown;amountMinor?:unknown;itemCode?:string}>){
 const tuition=lines.filter(l=>l.kind==='tuition'&&typeof l.amountMinor==='number'&&l.amountMinor>0);
 const codes=[...new Set(tuition.map(l=>l.itemCode?.trim().toLowerCase()??''))];
 if(!codes.length||codes.includes(''))throw new Error('Select a tuition item on the corresponding TRUST invoice.');
 if(codes.length!==1)throw new Error('Use one tuition item per invoice before preparing its PTY commission.');
 return codes[0];
}
