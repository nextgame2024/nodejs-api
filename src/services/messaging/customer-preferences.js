// Only explicit language choices change the persisted preference. Numeric slot
// selections, quoted assistant text and provider display names are not choices.
export function requestedLanguage(text) {
  const value = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!/(?:speak|talk|respond|reply|continue|prefer|language|habl|respon|continu|prefier|idioma|falar|fale|convers|escrev)/.test(value) && !/^(?:en |in |em )?(?:espanol|spanish|english|ingles|portugues|portuguese)[.!?]?$/.test(value)) return null;
  const matches = [...value.matchAll(/\b(espanol|spanish|english|ingles|portugues|portuguese)\b/g)];
  if (matches.length !== 1 || /\b(?:not|no|nao)\s+(?:in |en |em )?(?:espanol|spanish|english|ingles|portugues|portuguese)/.test(value)) return null;
  return ({espanol:'es',spanish:'es',english:'en',ingles:'en',portugues:'pt',portuguese:'pt'})[matches[0][1]];
}
export function bookingName(text) {
  const match = /^(?:name|nombre|nome)\s*:?\s+(.+)$/iu.exec(text.trim());
  const name = match?.[1]?.trim();
  return name && name.length <= 160 && /^[\p{L}\p{M}][\p{L}\p{M} .’'\-]*$/u.test(name) ? name : null;
}

export function bookingEmail(text) {
  const email = text.trim().replace(/^(?:email|e-mail|correo)\s*:\s*/i, '');
  return email.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}
