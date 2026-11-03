// Official Cloud API adapter. Concrete protocol stays outside messaging services.
export async function sendText(profile, input, { fetchImpl = fetch } = {}) {
  if (!profile.sendingEnabled || !profile.accessToken || !profile.graphVersion)
    throw new Error("Outbound profile unavailable.");
  let response;
  try {
    response = await fetchImpl(
      `https://graph.facebook.com/${profile.graphVersion}/${profile.phoneNumberId}/messages`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          authorization: `Bearer ${profile.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: input.recipient,
          type: "text",
          text: { preview_url: false, body: input.body },
          biz_opaque_callback_data: input.messageId,
        }),
      },
    );
  } catch {
    return { kind: "unknown", code: "send_unconfirmed" };
  }
  // A timeout/5xx/malformed success may have accepted the message. Never resend it blindly.
  if (!response.ok) await response.body?.cancel().catch(() => {});
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    return {
      kind: "retry",
      seconds:
        Number.isFinite(retry) && retry > 0
          ? Math.min(86400, Math.ceil(retry))
          : 60,
    };
  }
  if (response.status >= 500)
    return { kind: "unknown", code: "send_unconfirmed" };
  if (!response.ok)
    return {
      kind: "failed",
      code:
        response.status === 401 || response.status === 403
          ? "connection_attention"
          : "message_rejected",
    };
  try {
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) {
        await reader.cancel();
        return { kind: "unknown", code: "send_unconfirmed" };
      }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = data?.messages?.[0]?.id;
    return typeof id === "string" && id.length > 0 && id.length <= 300
      ? { kind: "accepted", providerMessageId: id }
      : { kind: "unknown", code: "send_unconfirmed" };
  } catch {
    return { kind: "unknown", code: "send_unconfirmed" };
  }
}
