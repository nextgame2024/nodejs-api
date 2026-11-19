// Only explicit customer instructions override matching the incoming medium.
export function requestedReplyFormat(text = "") {
  const t = text.toLowerCase();
  if (
    /\b(stop|no more|don't|do not)\b.{0,30}\b(voice|audio)\b|\b(no|sin)\b.{0,20}\baudio\b/u.test(
      t,
    )
  )
    return "match";
  if (
    /\b(reply|respond|answer|responde|responder|contesta)\b.{0,60}\b(text|texto)\b/u.test(
      t,
    )
  )
    return "match";
  if (
    /\b(always|every time|all replies|siempre|sempre)\b/u.test(t) &&
    /\b(voice|audio|voz)\b/u.test(t) &&
    /\b(reply|respond|answer|replies|responde|responder|contesta|respuestas|responda)\b/u.test(
      t,
    )
  )
    return "voice";
  return null;
}
export function replyFormat(events) {
  const preference = events
    .map((e) => requestedReplyFormat(e.body))
    .find(Boolean);
  if (preference === "voice") return "voice";
  const latest = events[0];
  return latest?.metadata?.messageType === "audio" ||
    latest?.metadata?.transcriptOf
    ? "voice"
    : "text";
}
