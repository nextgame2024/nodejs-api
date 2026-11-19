// A knowledge gap does not grant a mutation or hand off ownership. It only
// supplies a helpful next step through the already-authorized booking boundary.
export function needsTeamAnswer(result) {
  return (
    result?.needsTeam === true ||
    /(?:can(?:not|[’']t) confirm|(?:don[’']t|do not) have (?:a )?(?:confirmed|exact)|(?:isn[’']t|not) confirmed|team member.{0,40}(?:confirm|review)|no (?:tengo|puedo confirmar)|n[ãa]o (?:tenho|posso confirmar))/iu.test(
      result?.answer || "",
    )
  );
}
export function teamAppointmentNextStep(
  language,
  appointment,
  formattedTime,
  alreadyMentioned = false,
) {
  const code = String(language || "en")
    .split("-")[0]
    .toLowerCase();
  if (appointment && alreadyMentioned)
    return (
      {
        es: "Esta es otra pregunta que puedes llevar a la reunión con el equipo.",
        pt: "Essa é outra pergunta que você pode levar à reunião com a equipe.",
        en: "That’s another question you can bring to your meeting with the team.",
      }[code] ||
      "That’s another question you can bring to your meeting with the team."
    );
  if (code === "es")
    return appointment
      ? `Veo que tienes una cita el ${formattedTime}; puedes consultar esta pregunta con el equipo entonces. ¿En qué más puedo ayudarte?`
      : "Alguien del equipo puede ayudarte con esa consulta. ¿Te gustaría que te ayude a reservar una cita?";
  if (code === "pt")
    return appointment
      ? `Vejo que você tem uma consulta em ${formattedTime}; você pode levar essa pergunta à equipe. Em que mais posso ajudar?`
      : "Alguém da equipe pode ajudar com essa pergunta. Gostaria de agendar uma conversa?";
  return appointment
    ? `I can see you have an appointment on ${formattedTime}; please bring that question to the team then. What else can I help with?`
    : "Someone on our team can help with that question. Would you like me to help book an appointment?";
}
