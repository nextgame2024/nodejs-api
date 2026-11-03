import { createHash, randomInt, randomUUID } from "node:crypto";
import { hash } from "../leads/lead-records.contracts.js";
import {
  authorizedAvailability,
  changeAuthorizedAppointment,
} from "./lead-appointments.service.js";
import { bookingInput, date, zone } from "./lead-appointments.contracts.js";
import { localParts } from "./lead-appointments.slots.js";
import { bookingCapabilityContext } from "./whatsapp-appointment-booking.service.js";
const s = "sophia_runtime";
const locale = (language) =>
  ({ es: "es-AU", pt: "pt-BR", en: "en-AU" })[language] ?? "en-AU";
const messages = {
  en: {
    askDate: "What new date would you prefer for your appointment?",
    noAppointment:
      "I could not find one upcoming appointment to change. Our team can help you with this request.",
    range: (a, b, timezone) =>
      `Please choose a date from ${a} to ${b}. Appointment times use ${timezone}.`,
    none: (day, timezone) =>
      `There are no alternative appointment times on ${day} (${timezone}). Please choose another date.`,
    offer: (options, timezone) =>
      `Alternative appointment times (${timezone}):\n${options}\nReply with 1, 2 or 3 to select a new time. Your current appointment will remain unchanged until you confirm.`,
    rescheduleConfirm: (time, timezone, code) =>
      `You selected ${time} (${timezone}). Reply exactly CONFIRM ${code} to reschedule. Your current appointment remains unchanged until then. This selection expires in 15 minutes.`,
    cancelConfirm: (time, timezone, code) =>
      `Your appointment is ${time} (${timezone}). Reply exactly CONFIRM ${code} to cancel it. It will remain booked until you confirm. This request expires in 15 minutes.`,
    wrongCode:
      "That confirmation code does not match. Use the latest code exactly as shown.",
    expired:
      "That appointment change has expired or the appointment changed. Please ask again or contact our team.",
    cancelled: "Your appointment has been cancelled.",
    rescheduled: (time, timezone) =>
      `Your appointment has been rescheduled to ${time} (${timezone}).`,
  },
  es: {
    askDate: "¿Qué nueva fecha prefieres para tu cita?",
    noAppointment:
      "No pude encontrar una única cita próxima para cambiar. Nuestro equipo puede ayudarte.",
    range: (a, b, timezone) =>
      `Elige una fecha entre ${a} y ${b}. Los horarios usan ${timezone}.`,
    none: (day, timezone) =>
      `No hay horarios alternativos el ${day} (${timezone}). Elige otra fecha.`,
    offer: (options, timezone) =>
      `Horarios alternativos (${timezone}):\n${options}\nResponde 1, 2 o 3 para seleccionar un nuevo horario. Tu cita actual no cambiará hasta que confirmes.`,
    rescheduleConfirm: (time, timezone, code) =>
      `Seleccionaste ${time} (${timezone}). Responde exactamente CONFIRM ${code} para reprogramar. Tu cita actual no cambiará hasta entonces. La selección vence en 15 minutos.`,
    cancelConfirm: (time, timezone, code) =>
      `Tu cita es ${time} (${timezone}). Responde exactamente CONFIRM ${code} para cancelarla. Seguirá reservada hasta que confirmes. La solicitud vence en 15 minutos.`,
    wrongCode:
      "El código de confirmación no coincide. Usa exactamente el último código mostrado.",
    expired:
      "El cambio venció o la cita cambió. Solicítalo nuevamente o contacta a nuestro equipo.",
    cancelled: "Tu cita ha sido cancelada.",
    rescheduled: (time, timezone) =>
      `Tu cita ha sido reprogramada para ${time} (${timezone}).`,
  },
  pt: {
    askDate: "Qual nova data você prefere para a consulta?",
    noAppointment:
      "Não encontrei uma única consulta futura para alterar. Nossa equipe pode ajudar.",
    range: (a, b, timezone) =>
      `Escolha uma data entre ${a} e ${b}. Os horários usam ${timezone}.`,
    none: (day, timezone) =>
      `Não há horários alternativos em ${day} (${timezone}). Escolha outra data.`,
    offer: (options, timezone) =>
      `Horários alternativos (${timezone}):\n${options}\nResponda 1, 2 ou 3 para selecionar um novo horário. Sua consulta atual não mudará até a confirmação.`,
    rescheduleConfirm: (time, timezone, code) =>
      `Você selecionou ${time} (${timezone}). Responda exatamente CONFIRM ${code} para reagendar. Sua consulta atual não mudará até então. A seleção expira em 15 minutos.`,
    cancelConfirm: (time, timezone, code) =>
      `Sua consulta é ${time} (${timezone}). Responda exatamente CONFIRM ${code} para cancelar. Ela continuará marcada até a confirmação. A solicitação expira em 15 minutos.`,
    wrongCode:
      "O código de confirmação não confere. Use exatamente o último código exibido.",
    expired:
      "A alteração expirou ou a consulta mudou. Solicite novamente ou fale com nossa equipe.",
    cancelled: "Sua consulta foi cancelada.",
    rescheduled: (time, timezone) =>
      `Sua consulta foi reagendada para ${time} (${timezone}).`,
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
const codeHash = (tenant, request, code) =>
  createHash("sha256").update(`${tenant}:${request}:${code}`).digest("hex");

async function currentAppointment(db, tenant, leadId) {
  const rows = (
    await db.query(
      `SELECT appointment_id,advisor_identity,starts_at,customer_timezone,description,version
       FROM ${s}.lead_appointments WHERE customer_id=$1 AND lead_id=$2
       AND status='confirmed' AND starts_at>now() ORDER BY starts_at,appointment_id LIMIT 2 FOR UPDATE`,
      [tenant, leadId],
    )
  ).rows;
  return rows.length === 1 ? rows[0] : null;
}

async function cancelActiveRequests(db, tenant, conversationId) {
  await db.query(
    `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='newer_message',updated_at=now()
     WHERE customer_id=$1 AND conversation_id=$2 AND state='queued'
     AND (appointment_offer_id IN (SELECT offer_id FROM ${s}.lead_appointment_offers WHERE customer_id=$1 AND conversation_id=$2 AND status IN ('offered','awaiting_confirmation'))
       OR appointment_change_request_id IN (SELECT request_id FROM ${s}.lead_appointment_change_requests WHERE customer_id=$1 AND conversation_id=$2 AND status IN ('offered','awaiting_confirmation')))`,
    [tenant, conversationId],
  );
  await db.query(
    `UPDATE ${s}.lead_appointment_offers SET status='cancelled',updated_at=now()
     WHERE customer_id=$1 AND conversation_id=$2 AND status IN ('offered','awaiting_confirmation')`,
    [tenant, conversationId],
  );
  await db.query(
    `UPDATE ${s}.lead_appointment_change_requests SET status='cancelled',updated_at=now()
     WHERE customer_id=$1 AND conversation_id=$2 AND status IN ('offered','awaiting_confirmation')`,
    [tenant, conversationId],
  );
}

export async function createAppointmentChangeRequest(
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
  if (request.action === "clarify_reschedule_date")
    return { body: text.askDate };
  await cancelActiveRequests(
    db,
    profile.customerId,
    conversation.conversation_id,
  );
  const existing = await currentAppointment(
    db,
    profile.customerId,
    lead.lead_id,
  );
  if (!existing || existing.advisor_identity !== context.advisorId)
    return { body: text.noAppointment };
  const requestId = randomUUID();
  if (request.action === "cancel") {
    const code = String(randomInt(100000, 1000000));
    await db.query(
      `INSERT INTO ${s}.lead_appointment_change_requests
       (request_id,customer_id,channel_id,lead_id,conversation_id,source_event_id,reply_job_id,ownership_version,appointment_id,expected_version,action,advisor_identity,customer_timezone,confirmation_code_hash,status,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'cancel',$11,$12,$13,'awaiting_confirmation',now()+interval '15 minutes')`,
      [
        requestId,
        profile.customerId,
        channel.channel_id,
        lead.lead_id,
        conversation.conversation_id,
        job.source_event_id,
        job.job_id,
        job.ownership_version,
        existing.appointment_id,
        existing.version,
        existing.advisor_identity,
        existing.customer_timezone,
        codeHash(profile.customerId, requestId, code),
      ],
    );
    return {
      appointmentChangeRequestId: requestId,
      body: text.cancelConfirm(
        display(existing.starts_at, existing.customer_timezone, lead.language),
        existing.customer_timezone,
        code,
      ),
    };
  }
  let day;
  try {
    day = date(request.date);
  } catch {
    return { body: text.askDate };
  }
  let customerTimezone = existing.customer_timezone;
  if (request.timezone)
    try {
      customerTimezone = zone(request.timezone);
    } catch {
      customerTimezone = existing.customer_timezone;
    }
  const minimumDate = localDate(Date.now(), customerTimezone);
  const maximumDate = localDate(
    Date.now() + context.bookingWindowDays * 86400000,
    customerTimezone,
  );
  if (day < minimumDate || day > maximumDate)
    return { body: text.range(minimumDate, maximumDate, customerTimezone) };
  const available = await authorizedAvailability(
    db,
    profile.customerId,
    existing.advisor_identity,
    day,
    customerTimezone,
    existing.appointment_id,
  );
  const slots = available.slots
    .filter(
      (slot) =>
        new Date(slot.startsAt).toISOString() !==
        new Date(existing.starts_at).toISOString(),
    )
    .slice(0, 3);
  if (!slots.length) return { body: text.none(day, customerTimezone) };
  await db.query(
    `INSERT INTO ${s}.lead_appointment_change_requests
     (request_id,customer_id,channel_id,lead_id,conversation_id,source_event_id,reply_job_id,ownership_version,appointment_id,expected_version,action,advisor_identity,customer_timezone,calendar_revision,slots,status,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reschedule',$11,$12,$13,$14::jsonb,'offered',now()+interval '30 minutes')`,
    [
      requestId,
      profile.customerId,
      channel.channel_id,
      lead.lead_id,
      conversation.conversation_id,
      job.source_event_id,
      job.job_id,
      job.ownership_version,
      existing.appointment_id,
      existing.version,
      existing.advisor_identity,
      customerTimezone,
      available.calendarRevision,
      JSON.stringify(slots),
    ],
  );
  return {
    appointmentChangeRequestId: requestId,
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

async function queue(
  db,
  profile,
  channel,
  lead,
  conversation,
  requestId,
  body,
) {
  const requestKey = randomUUID();
  await db.query(
    `INSERT INTO ${s}.assistant_message_outbox(customer_id,channel_id,lead_id,conversation_id,ownership_version,appointment_change_request_id,body,request_key,request_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      profile.customerId,
      channel.channel_id,
      lead.lead_id,
      conversation.conversation_id,
      conversation.ownership_version,
      requestId,
      body,
      requestKey,
      hash({ body }),
    ],
  );
}

async function cancelQueued(db, tenant, requestId) {
  await db.query(
    `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='newer_message',updated_at=now()
     WHERE customer_id=$1 AND appointment_change_request_id=$2 AND state='queued'`,
    [tenant, requestId],
  );
}

export async function handleAppointmentChangeConfirmation(
  db,
  profile,
  channel,
  lead,
  conversation,
  body,
) {
  const confirmation = /^confirm\s+(\d{6})$/i.exec(body.trim());
  const request = (
    await db.query(
      `SELECT * FROM ${s}.lead_appointment_change_requests WHERE customer_id=$1 AND conversation_id=$2
       AND status IN ('offered','awaiting_confirmation') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [profile.customerId, conversation.conversation_id],
    )
  ).rows[0];
  if (!request) {
    if (!confirmation) return false;
    const confirmed = (
      await db.query(
        `SELECT r.*,a.starts_at FROM ${s}.lead_appointment_change_requests r
         JOIN ${s}.lead_appointments a USING(customer_id,appointment_id)
         WHERE r.customer_id=$1 AND r.conversation_id=$2 AND r.status='confirmed'
         ORDER BY r.updated_at DESC LIMIT 1`,
        [profile.customerId, conversation.conversation_id],
      )
    ).rows[0];
    if (
      !confirmed ||
      codeHash(profile.customerId, confirmed.request_id, confirmation[1]) !==
        confirmed.confirmation_code_hash
    )
      return false;
    const text = copy(lead.language);
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      confirmed.request_id,
      confirmed.action === "cancel"
        ? text.cancelled
        : text.rescheduled(
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
  const context = await bookingCapabilityContext(
    db,
    profile,
    channel,
    lead,
    conversation,
  );
  if (!context || request.ownership_version !== conversation.ownership_version)
    return false;
  const text = copy(lead.language);
  const current = await currentAppointment(
    db,
    profile.customerId,
    lead.lead_id,
  );
  if (
    !current ||
    current.appointment_id !== request.appointment_id ||
    current.version !== request.expected_version ||
    current.advisor_identity !== context.advisorId
  ) {
    await db.query(
      `UPDATE ${s}.lead_appointment_change_requests SET status='expired',updated_at=now() WHERE customer_id=$1 AND request_id=$2`,
      [profile.customerId, request.request_id],
    );
    if (/^(?:[1-3]|confirm\s+\d{6})$/i.test(body.trim())) {
      await cancelQueued(db, profile.customerId, request.request_id);
      await queue(
        db,
        profile,
        channel,
        lead,
        conversation,
        request.request_id,
        text.expired,
      );
      return true;
    }
    return false;
  }
  if (Date.parse(request.expires_at) <= Date.now()) {
    await db.query(
      `UPDATE ${s}.lead_appointment_change_requests SET status='expired',updated_at=now() WHERE customer_id=$1 AND request_id=$2`,
      [profile.customerId, request.request_id],
    );
    if (/^(?:[1-3]|confirm\s+\d{6})$/i.test(body.trim())) {
      await cancelQueued(db, profile.customerId, request.request_id);
      await queue(
        db,
        profile,
        channel,
        lead,
        conversation,
        request.request_id,
        text.expired,
      );
      return true;
    }
    return false;
  }
  const value = body.trim();
  if (request.status === "offered") {
    if (!/^[1-3]$/.test(value)) return false;
    const slot = request.slots[Number(value) - 1];
    if (!slot) return false;
    const code = String(randomInt(100000, 1000000));
    await db.query(
      `UPDATE ${s}.lead_appointment_change_requests SET status='awaiting_confirmation',selected_starts_at=$3,confirmation_code_hash=$4,expires_at=now()+interval '15 minutes',updated_at=now()
       WHERE customer_id=$1 AND request_id=$2`,
      [
        profile.customerId,
        request.request_id,
        slot.startsAt,
        codeHash(profile.customerId, request.request_id, code),
      ],
    );
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      request.request_id,
      text.rescheduleConfirm(
        display(slot.startsAt, request.customer_timezone, lead.language),
        request.customer_timezone,
        code,
      ),
    );
    return true;
  }
  if (!confirmation) return false;
  if (
    codeHash(profile.customerId, request.request_id, confirmation[1]) !==
    request.confirmation_code_hash
  ) {
    const exhausted = request.confirmation_attempts >= 4;
    await db.query(
      `UPDATE ${s}.lead_appointment_change_requests SET confirmation_attempts=confirmation_attempts+1,status=CASE WHEN $3 THEN 'expired' ELSE status END,updated_at=now() WHERE customer_id=$1 AND request_id=$2`,
      [profile.customerId, request.request_id, exhausted],
    );
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      request.request_id,
      exhausted ? text.expired : text.wrongCode,
    );
    return true;
  }
  const appointment = (
    await db.query(
      `SELECT description FROM ${s}.lead_appointments WHERE customer_id=$1 AND appointment_id=$2`,
      [profile.customerId, request.appointment_id],
    )
  ).rows[0];
  const input = bookingInput(
    request.action === "cancel"
      ? {
          requestKey: request.request_id,
          leadId: lead.lead_id,
          expectedVersion: request.expected_version,
        }
      : {
          requestKey: request.request_id,
          leadId: lead.lead_id,
          expectedVersion: request.expected_version,
          advisorId: request.advisor_identity,
          startsAt: new Date(request.selected_starts_at).toISOString(),
          timezone: request.customer_timezone,
          calendarRevision: request.calendar_revision,
          description: appointment?.description ?? "WhatsApp appointment",
        },
    request.action,
  );
  try {
    const result = await changeAuthorizedAppointment(
      db,
      profile.customerId,
      `whatsapp:${channel.channel_id}`,
      lead,
      request.action,
      request.appointment_id,
      input,
      { origin: "whatsapp_customer_confirmation" },
    );
    await db.query(
      `UPDATE ${s}.lead_appointment_change_requests SET status='confirmed',updated_at=now() WHERE customer_id=$1 AND request_id=$2`,
      [profile.customerId, request.request_id],
    );
    await cancelQueued(db, profile.customerId, request.request_id);
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      request.request_id,
      request.action === "cancel"
        ? text.cancelled
        : text.rescheduled(
            display(
              result.appointment.startsAt,
              request.customer_timezone,
              lead.language,
            ),
            request.customer_timezone,
          ),
    );
  } catch (error) {
    if (![404, 409].includes(error?.status)) throw error;
    await db.query(
      `UPDATE ${s}.lead_appointment_change_requests SET status='expired',updated_at=now() WHERE customer_id=$1 AND request_id=$2`,
      [profile.customerId, request.request_id],
    );
    await cancelQueued(db, profile.customerId, request.request_id);
    await queue(
      db,
      profile,
      channel,
      lead,
      conversation,
      request.request_id,
      text.expired,
    );
  }
  return true;
}
