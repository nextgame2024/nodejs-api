import { bookingName, bookingEmail } from "./customer-preferences.js";
const s = "sophia_runtime";

// A WhatsApp profile label is not a customer-confirmed booking name.
export async function customerContact(db, tenant, lead, conversation) {
  const evidence =
    (
      await db.query(
        `SELECT 1 FROM ${s}.assistant_lead_events
    WHERE customer_id=$1 AND conversation_id=$2 AND kind='lead_updated'
      AND (metadata->>'origin' IN ('customer_booking_name','customer_contact_name')
        OR (metadata->>'factsSource'='staff_entry' AND metadata->'changedFields' ? 'displayName')) LIMIT 1`,
        [tenant, conversation.conversation_id],
      )
    ).rows.length > 0;
  return {
    hasName:
      !!lead.display_name?.trim() &&
      ((!!lead.created_by_identity &&
        lead.created_by_identity !== "whatsapp") ||
        evidence),
    hasEmail: !!bookingEmail(lead.email || ""),
  };
}

// Only explicit customer statements are stored. General conversation is never
// guessed to be a name, and a provider's display name is not confirmation.
export async function captureCustomerContact(
  db,
  tenant,
  lead,
  conversation,
  body,
) {
  const name = bookingName(body);
  const email = bookingEmail(body);
  if (!name && !email) return;
  await db.query(
    `UPDATE ${s}.assistant_leads SET display_name=COALESCE($3,display_name),
    email=COALESCE($4,email),record_version=record_version+1,updated_at=now()
    WHERE customer_id=$1 AND lead_id=$2`,
    [tenant, lead.lead_id, name, email],
  );
  await db.query(
    `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,kind,body,metadata)
    VALUES($1,$2,'lead_updated','Contact detail supplied by customer',$3::jsonb)`,
    [
      tenant,
      conversation.conversation_id,
      JSON.stringify({
        origin: name ? "customer_contact_name" : "customer_contact_email",
      }),
    ],
  );
  if (name) lead.display_name = name;
  if (email) lead.email = email;
}

export function contactRequest(language, contact, mandatory = false) {
  const lang = String(language || "en").split("-")[0];
  if (mandatory)
    return (
      {
        es: "Claro, ¿a qué nombre reservamos la cita? Puedes responder «NOMBRE» seguido de tu nombre. El correo es opcional.",
        pt: "Claro, em que nome fazemos a reserva? Pode responder NOME seguido do seu nome. O e-mail é opcional.",
        en: "Of course—what name should I put on the appointment? You can reply NAME followed by your name. Email is optional.",
      }[lang] ||
      "What name should I put on the appointment? Reply NAME followed by your name. Email is optional."
    );
  const fields = contact.hasName
    ? { en: "email address", es: "correo electrónico", pt: "e-mail" }
    : contact.hasEmail
      ? { en: "name", es: "nombre", pt: "nome" }
      : {
          en: "name and email address",
          es: "nombre y correo electrónico",
          pt: "nome e e-mail",
        };
  if (lang === "es")
    return `¡Hola! Con gusto te ayudo. ¿Me confirmas tu ${fields.es}? Si prefieres, podemos seguir sin esos datos por ahora.`;
  if (lang === "pt")
    return `Olá! Será um prazer ajudar. Pode confirmar seu ${fields.pt}? Se preferir, podemos continuar sem esses dados por enquanto.`;
  return `Hi! Happy to help. Could you confirm your ${fields.en}? We can keep chatting without those details for now if you prefer.`;
}

export async function firstContactRequest(db, tenant, lead, conversation) {
  const contact = await customerContact(db, tenant, lead, conversation);
  if (contact.hasName && contact.hasEmail) return null;
  const asked =
    (
      await db.query(
        `SELECT 1 FROM ${s}.assistant_reply_jobs
    WHERE customer_id=$1 AND conversation_id=$2 AND usage->'engagement'->>'contactRequested'='true' LIMIT 1`,
        [tenant, conversation.conversation_id],
      )
    ).rows.length > 0;
  return asked ? null : contactRequest(lead.language, contact);
}
