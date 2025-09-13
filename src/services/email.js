import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({
  region: process.env.SES_REGION || process.env.S3_REGION,
});
const FROM = process.env.SES_FROM; // e.g., "sophiaAi <no-reply@yourdomain.com>"

export async function sendRenderReadyEmail({
  to,
  jobId,
  effectName,
  successUrl,
  expiresAt,
}) {
  if (!FROM || !to) return;
  const subject = `${effectName} is ready`;
  const bodyHtml = `
    <p>Your sophiaAi video is ready 🎉</p>
    <p><a href="${successUrl}">Open your video</a></p>
    <p>This link shows the video and will remain available for 24 hours (until ${new Date(expiresAt).toLocaleString()}).</p>
  `;
  const bodyText = `Your sophiaAi video is ready. Open: ${successUrl}`;
  await ses.send(
    new SendEmailCommand({
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: {
          Html: { Data: bodyHtml },
          Text: { Data: bodyText },
        },
      },
      Source: FROM,
    })
  );
}
