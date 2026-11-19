// Only explicit language choices change the persisted preference. Numeric slot
// selections, quoted assistant text and provider display names are not choices.
export function requestedLanguage(text) {
  const value = String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (
    !/(?:speak|talk|respond|reply|continue|prefer|language|habl|respon|continu|prefier|idioma|falar|fale|convers|escrev)/.test(
      value,
    ) &&
    !/^(?:en |in |em )?(?:espanol|spanish|english|ingles|portugues|portuguese)[.!?]?$/.test(
      value,
    )
  )
    return null;
  const matches = [
    ...value.matchAll(
      /\b(espanol|spanish|english|ingles|portugues|portuguese)\b/g,
    ),
  ];
  if (
    matches.length !== 1 ||
    /\b(?:not|no|nao)\s+(?:in |en |em )?(?:espanol|spanish|english|ingles|portugues|portuguese)/.test(
      value,
    )
  )
    return null;
  return {
    espanol: "es",
    spanish: "es",
    english: "en",
    ingles: "en",
    portugues: "pt",
    portuguese: "pt",
  }[matches[0][1]];
}
// Parse contact-only replies, never treat a question or business request as a name.
export function contactDetails(text) {
  const value = String(text).trim();
  if (!value || value.length > 600 || /[?¿<>]/u.test(value)) return null;
  const addresses = value.match(/[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+/gu) || [];
  if (addresses.length > 1) return null;
  const email = addresses[0]?.replace(/[.!]+$/, "") || null;
  if (email && email.length > 320) return null;
  let rest = email ? value.replace(addresses[0], "") : value;
  rest = rest
    .replace(
      /\b(?:and my email is|my email is|my email|email address|email|e-mail|correo electrónico|correo|meu email)\s*:?\s*/giu,
      " ",
    )
    .replace(/^[\s,;:.]+|[\s,;:.]+$/gu, "");
  const explicit =
    /^(?:name|nombre|nome|my name is|me llamo|mi nombre es|meu nome é)\s*:?\s+(.+)$/iu.exec(
      rest,
    );
  let name = explicit?.[1] || (email ? rest : "");
  name = name.replace(/^[\s,;:.]+|[\s,;:.]+$/gu, "").trim();
  if (
    name &&
    ((!explicit && name.length < 2) ||
      !/^[\p{L}\p{M}][\p{L}\p{M} .’'\-]*$/u.test(name) ||
      name.length > 160 ||
      name.split(/\s+/).length > 8 ||
      /\b(?:want|need|help|price|pricing|book|booking|thanks|thank|don't|not|quiero|necesito|precio|gracias|obrigado)\b/iu.test(
        name,
      ))
  )
    return null;
  if (!name && !email) return null;
  return { name: name || null, email };
}
export function bookingName(text) {
  return contactDetails(text)?.name || null;
}
export function bookingEmail(text) {
  return contactDetails(text)?.email || null;
}
