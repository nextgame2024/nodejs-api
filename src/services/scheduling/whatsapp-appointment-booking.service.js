import { createHash, randomInt, randomUUID } from "node:crypto";
import { hash } from "../leads/lead-records.contracts.js";
import {
  authorizedAvailability,
  bookAuthorizedAppointment,
} from "./lead-appointments.service.js";
import { bookingInput, date, zone } from "./lead-appointments.contracts.js";
import { localParts } from "./lead-appointments.slots.js";
const s = "sophia_runtime";
const locale = (language) =>
  ({ es: "es-AU", pt: "pt-BR", en: "en-AU" })[language] ?? "en-AU";
const messages = {
  en: {
    askDate: "What date would you prefer for your appointment?",
    range: (a, b, zone) =>
      `Please choose a date from ${a} to ${b}. Appointment times use ${zone}.`,
    none: (day, zone) =>
      `There are no appointment times available on ${day} (${zone}). Please choose another date.`,
    offer: (options, zone) =>
      `Available appointment times (${zone}):\n${options}\nReply with 1, 2 or 3 to select a time. Nothing will be booked until you confirm.`,
    confirm: (time, zone, code) =>
      `You selected ${time} (${zone}). Reply exactly CONFIRM ${code} to book it. This selection expires in 15 minutes.`,
    wrongCode:
      "That confirmation code does not match. Use the latest code exactly as shown.",
    expired:
      "That appointment selection has expired or is no longer available. Ask for appointment times again.",
    booked: (time, zone) =>
      `Your appointment is confirmed for ${time} (${zone}). Our team can help if you need to change it.`,
  },
  es: {
    askDate: "¿Qué fecha prefieres para tu cita?",
    range: (a, b, zone) =>
      `Elige una fecha entre ${a} y ${b}. Los horarios de las citas usan ${zone}.`,
    none: (day, zone) =>
      `No hay horarios disponibles el ${day} (${zone}). Elige otra fecha.`,
    offer: (options, zone) =>
      `Horarios disponibles (${zone}):\n${options}\nResponde 1, 2 o 3 para seleccionar. No se reservará nada hasta que confirmes.`,
    confirm: (time, zone, code) =>
      `Seleccionaste ${time} (${zone}). Responde exactamente CONFIRM ${code} para reservar. La selección vence en 15 minutos.`,
    wrongCode:
      "El código de confirmación no coincide. Usa exactamente el último código mostrado.",
    expired:
      "La selección venció o ya no está disponible. Solicita horarios de citas nuevamente.",
    booked: (time, zone) =>
      `Tu cita está confirmada para ${time} (${zone}). Nuestro equipo puede ayudarte si necesitas cambiarla.`,
  },
  pt: {
    askDate: "Qual data você prefere para a consulta?",
    range: (a, b, zone) =>
      `Escolha uma data entre ${a} e ${b}. Os horários usam ${zone}.`,
    none: (day, zone) =>
      `Não há horários disponíveis em ${day} (${zone}). Escolha outra data.`,
    offer: (options, zone) =>
      `Horários disponíveis (${zone}):\n${options}\nResponda 1, 2 ou 3 para selecionar. Nada será reservado até você confirmar.`,
    confirm: (time, zone, code) =>
      `Você selecionou ${time} (${zone}). Responda exatamente CONFIRM ${code} para reservar. A seleção expira em 15 minutos.`,
    wrongCode:
      "O código de confirmação não confere. Use exatamente o último código exibido.",
    expired:
      "A seleção expirou ou não está mais disponível. Peça os horários novamente.",
    booked: (time, zone) =>
      `Sua consulta está confirmada para ${time} (${zone}). Nossa equipe pode ajudar se precisar alterá-la.`,
  },
};
const copy = (language) => messages[language] ?? messages.en;
const localDate = (instant, timezone) =>
  localParts(new Date(instant).toISOString(), timezone).date;
const display = (instant, timezone, language) =>
  new Intl.DateTimeFormat(locale(language), {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(instant));
const codeHash = (tenant, offer, code) =>
  createHash("sha256").update(`${tenant}:${offer}:${code}`).digest("hex");

export async function bookingCapabilityContext(
  db,
  profile,
  channel,
  lead,
  conversation,
) {
  if (
    process.env.WHATSAPP_BOOKING_ENABLED !== "true" ||
    !lead.assigned_to_identity ||
    lead.stage === "closed" ||
    conversation.ownership !== "bot"
  )
    return null;
  const ready = (
    await db.query(
      "SELECT to_regclass('sophia_runtime.lead_appointment_offers') IS NOT NULL AS offers,to_regclass('sophia_runtime.lead_appointments') IS NOT NULL AS appointments",
    )
  ).rows[0];
  if (!ready.offers || !ready.appointments) return null;
  const row = (
    await db.query(
      `SELECT c.timezone,c.booking_window_days AS "bookingWindowDays",c.revision
       FROM ${s}.lead_advisor_calendars c
       WHERE c.customer_id=$1 AND c.advisor_identity=$2
       AND EXISTS(SELECT 1 FROM ${s}.lead_assistant_setting_releases r
         WHERE r.customer_id=$1 AND COALESCE((r.configuration->>'appointmentBookingEnabled')::boolean,false)
         AND r.configuration->'advisorIds' ? $2
         AND r.source_revision=(SELECT max(x.source_revision) FROM ${s}.lead_assistant_setting_releases x WHERE x.customer_id=$1))`,
      [profile.customerId, lead.assigned_to_identity],
    )
  ).rows[0];
  if (!row || channel.enabled !== true) return null;
  const today = localDate(Date.now(), row.timezone);
  const maxDate = localDate(
    Date.now() + row.bookingWindowDays * 86400000,
    row.timezone,
  );
  return {
    advisorId: lead.assigned_to_identity,
    timezone: row.timezone,
    calendarRevision: row.revision,
    bookingWindowDays: row.bookingWindowDays,
    today,
    maxDate,
  };
}

export async function createAppointmentOffer(
  db,
  profile,
  channel,
  lead,
  conversation,
  job,
  request,
) {
  const context = await bookingCapabilityContext(
    db,
    profile,
    channel,
    lead,
    conversation,
  );
  if (!context) return null;
  const text = copy(lead.language);
  if (request?.action === "clarify_date") return { body: text.askDate };
  let day;
  try {
    day = date(request?.date);
  } catch {
    return { body: text.askDate };
  }
  let customerTimezone = context.timezone;
  if (request?.timezone)
    try {
      customerTimezone = zone(request.timezone);
    } catch {
      customerTimezone = context.timezone;
    }
  const minimumDate = localDate(Date.now(), customerTimezone);
  const maximumDate = localDate(
    Date.now() + context.bookingWindowDays * 86400000,
    customerTimezone,
  );
  if (day < minimumDate || day > maximumDate)
    return {
      body: text.range(minimumDate, maximumDate, customerTimezone),
    };
  const available = await authorizedAvailability(
    db,
    profile.customerId,
    context.advisorId,
    day,
    customerTimezone,
  );
  const slots = available.slots.slice(0, 3);
  if (!slots.length) return { body: text.none(day, customerTimezone) };
  await db.query(
    `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='newer_message',updated_at=now()
     WHERE customer_id=$1 AND conversation_id=$2 AND state='queued'
     AND appointment_offer_id IN (SELECT offer_id FROM ${s}.lead_appointment_offers WHERE customer_id=$1 AND conversation_id=$2 AND status IN ('offered','awaiting_confirmation'))`,
    [profile.customerId, conversation.conversation_id],
  );
  await db.query(
    `UPDATE ${s}.lead_appointment_offers SET status='cancelled',updated_at=now()
     WHERE customer_id=$1 AND conversation_id=$2 AND status IN ('offered','awaiting_confirmation')`,
    [profile.customerId, conversation.conversation_id],
  );
  await db.query(
    `INSERT INTO ${s}.lead_appointment_offers(customer_id,channel_id,lead_id,conversation_id,source_event_id,reply_job_id,ownership_version,advisor_identity,customer_timezone,calendar_revision,slots,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now()+interval '30 minutes')`,
    [
      profile.customerId,
      channel.channel_id,
      lead.lead_id,
      conversation.conversation_id,
      job.source_event_id,
      job.job_id,
      job.ownership_version,
      context.advisorId,
      customerTimezone,
      available.calendarRevision,
      JSON.stringify(slots),
    ],
  );
  return {
    body: text.offer(
      slots
        .map(
          (slot, index) =>
            `${index + 1}. ${display(slot.startsAt, customerTimezone, lead.language)}`,
        )
        .join("\n"),
      customerTimezone,
    ),
  };
}

async function queue(db, profile, channel, lead, conversation, offerId, body) {
  const requestKey = randomUUID();
  await db.query(
    `INSERT INTO ${s}.assistant_message_outbox(customer_id,channel_id,lead_id,conversation_id,ownership_version,appointment_offer_id,body,request_key,request_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      profile.customerId,
      channel.channel_id,
      lead.lead_id,
      conversation.conversation_id,
      conversation.ownership_version,
      offerId,
      body,
      requestKey,
      hash({ body }),
    ],
  );
}

async function cancelQueuedOfferMessages(db, tenant, offerId) {
  await db.query(
    `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='newer_message',updated_at=now()
     WHERE customer_id=$1 AND appointment_offer_id=$2 AND state='queued'`,
    [tenant, offerId],
  );
}

export async function handleAppointmentConfirmation(
  db,
  profile,
  channel,
  lead,
  conversation,
  body,
) {
  const context = await bookingCapabilityContext(
    db,
    profile,
    channel,
    lead,
    conversation,
  );
  if (!context) return false;
  const offer = (
    await db.query(
      `SELECT * FROM ${s}.lead_appointment_offers WHERE customer_id=$1 AND conversation_id=$2
       AND status IN ('offered','awaiting_confirmation') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [profile.customerId, conversation.conversation_id],
    )
  ).rows[0];
  const confirmation = /^confirm\s+(\d{6})$/i.exec(body.trim());
  if (!offer) {
    if (!confirmation) return false;
    const confirmed = (
      await db.query(
        `SELECT o.*,a.starts_at FROM ${s}.lead_appointment_offers o JOIN ${s}.lead_appointments a USING(customer_id,appointment_id)
         WHERE o.customer_id=$1 AND o.conversation_id=$2 AND o.status='confirmed' ORDER BY o.updated_at DESC LIMIT 1`,
        [profile.customerId, conversation.conversation_id],
      )
    ).rows[0];
    if (
      !confirmed ||
      codeHash(profile.customerId, confirmed.offer_id, confirmation[1]) !==
        confirmed.confirmation_code_hash
    )
      return false;
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      confirmed.offer_id,
      copy(lead.language).booked(
        display(
          confirmed.starts_at,
          confirmed.customer_timezone,
          lead.language,
        ),
        confirmed.customer_timezone,
      ),
    );
    return true;
  }
  if (offer.ownership_version !== conversation.ownership_version) return false;
  const text = copy(lead.language);
  if (Date.parse(offer.expires_at) <= Date.now()) {
    await db.query(
      `UPDATE ${s}.lead_appointment_offers SET status='expired',updated_at=now() WHERE customer_id=$1 AND offer_id=$2`,
      [profile.customerId, offer.offer_id],
    );
    if (/^(?:[1-3]|confirm\s+\d{6})$/i.test(body.trim())) {
      await cancelQueuedOfferMessages(db, profile.customerId, offer.offer_id);
      await queue(
        db,
        profile,
        channel,
        lead,
        conversation,
        offer.offer_id,
        text.expired,
      );
      return true;
    }
    return false;
  }
  const value = body.trim();
  if (offer.status === "offered") {
    if (!/^[1-3]$/.test(value)) return false;
    const slot = offer.slots[Number(value) - 1];
    if (!slot) return false;
    const code = String(randomInt(100000, 1000000));
    await db.query(
      `UPDATE ${s}.lead_appointment_offers SET status='awaiting_confirmation',selected_starts_at=$3,confirmation_code_hash=$4,expires_at=now()+interval '15 minutes',updated_at=now()
       WHERE customer_id=$1 AND offer_id=$2`,
      [
        profile.customerId,
        offer.offer_id,
        slot.startsAt,
        codeHash(profile.customerId, offer.offer_id, code),
      ],
    );
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      offer.offer_id,
      text.confirm(
        display(slot.startsAt, offer.customer_timezone, lead.language),
        offer.customer_timezone,
        code,
      ),
    );
    return true;
  }
  if (!confirmation) return false;
  if (
    codeHash(profile.customerId, offer.offer_id, confirmation[1]) !==
    offer.confirmation_code_hash
  ) {
    const exhausted = offer.confirmation_attempts >= 4;
    await db.query(
      `UPDATE ${s}.lead_appointment_offers SET confirmation_attempts=confirmation_attempts+1,status=CASE WHEN $3 THEN 'expired' ELSE status END,updated_at=now() WHERE customer_id=$1 AND offer_id=$2`,
      [profile.customerId, offer.offer_id, exhausted],
    );
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      offer.offer_id,
      exhausted ? text.expired : text.wrongCode,
    );
    return true;
  }
  const input = bookingInput(
    {
      requestKey: offer.offer_id,
      leadId: lead.lead_id,
      advisorId: offer.advisor_identity,
      startsAt: new Date(offer.selected_starts_at).toISOString(),
      timezone: offer.customer_timezone,
      calendarRevision: offer.calendar_revision,
      description: "WhatsApp appointment",
    },
    "book",
  );
  try {
    const result = await bookAuthorizedAppointment(
      db,
      profile.customerId,
      `whatsapp:${channel.channel_id}`,
      lead,
      input,
      { origin: "whatsapp_customer_confirmation" },
    );
    await db.query(
      `UPDATE ${s}.lead_appointment_offers SET status='confirmed',appointment_id=$3,updated_at=now() WHERE customer_id=$1 AND offer_id=$2`,
      [profile.customerId, offer.offer_id, result.appointment.id],
    );
    await cancelQueuedOfferMessages(db, profile.customerId, offer.offer_id);
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      offer.offer_id,
      text.booked(
        display(
          result.appointment.startsAt,
          offer.customer_timezone,
          lead.language,
        ),
        offer.customer_timezone,
      ),
    );
  } catch (error) {
    if (error?.status !== 409) throw error;
    await db.query(
      `UPDATE ${s}.lead_appointment_offers SET status='expired',updated_at=now() WHERE customer_id=$1 AND offer_id=$2`,
      [profile.customerId, offer.offer_id],
    );
    await cancelQueuedOfferMessages(db, profile.customerId, offer.offer_id);
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      offer.offer_id,
      text.expired,
    );
  }
  return true;
}
