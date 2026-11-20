import { createHash } from "node:crypto";
// Deployment-owned public aliases; a customer cannot select a different form.
export function preparationConfigs(env = process.env) {
  const entries = JSON.parse(env.APPOINTMENT_PREPARATION_FORMS || "{}");
  const result = {};
  const slugs = new Set();
  for (const [tenant, p] of Object.entries(entries)) {
    if (
      !/^[a-f0-9-]{36}$/i.test(tenant) ||
      !/^[a-z][a-z0-9-]{2,60}$/.test(p.slug || "") ||
      !/^[a-f0-9-]{36}\.[a-f0-9-]{36}$/i.test(p.publicToken || "")
    )
      throw Error("Invalid appointment preparation configuration");
    const origin = new URL(p.origin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      slugs.has(p.slug)
    )
      throw Error("Invalid appointment preparation origin");
    slugs.add(p.slug);
    result[tenant] = { ...p, url: origin.origin + "/forms/" + p.slug };
  }
  return result;
}
export const emailFingerprint = (email) =>
  createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex");
export async function confirmedEmail(db, tenant, lead) {
  if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email))
    return false;
  return !!(
    await db.query(
      `SELECT 1 FROM sophia_runtime.assistant_lead_events e JOIN sophia_runtime.assistant_lead_conversations c USING(customer_id,conversation_id) WHERE e.customer_id=$1 AND c.lead_id=$2 AND e.kind='lead_updated' AND e.metadata->>'confirmedEmailHash'=$3 LIMIT 1`,
      [tenant, lead.lead_id, emailFingerprint(lead.email)],
    )
  ).rowCount;
}
export async function meetingInvitation(db, tenant, lead) {
  const p = preparationConfigs()[tenant];
  if (!p) return "";
  const email = await confirmedEmail(db, tenant, lead);
  const copy = {
    en: `Before we meet, please complete this short form so we can understand your business and make the most of our time together: ${p.url}`,
    es: `Antes de reunirnos, completa este breve formulario para que podamos conocer tu negocio y aprovechar mejor la reunión: ${p.url}`,
    pt: `Antes da reunião, preencha este breve formulário para conhecermos seu negócio e aproveitarmos melhor nosso tempo juntos: ${p.url}`,
  };
  const ask = {
    en: "If you would like an email confirmation, please send your email address.",
    es: "Si quieres recibir la confirmación por correo, envíame tu dirección de correo electrónico.",
    pt: "Se quiser receber a confirmação por e-mail, envie seu endereço de e-mail.",
  };
  return (
    "\n\n" +
    (copy[lead.language] || copy.en) +
    (email ? "" : "\n\n" + (ask[lead.language] || ask.en))
  );
}
