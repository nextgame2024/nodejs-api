# Sophia AI real-number onboarding

Prepared 19 November 2026. Scope: Sophia AI's own +61 400 388 532,
not Open for Australia. App ID from the owner's Meta dashboard:
`1107965912211301`. Configuration ID supplied by owner:
`1141808901544273`.

## Current delivery boundary

The source implements a staged authorization prototype: a manager prepares an
attempt, explicitly launches Meta, exchanges the short-lived code server-side,
and verifies the expected number belongs to the authorized account and has both
`is_on_biz_app=true` and `platform_type=CLOUD_API`. A verified authorization is
**pending activation**. It does not subscribe a WABA, synchronize history, change
deployment-owned channel profiles or send messages. Do not enable signup on a
real number until the remaining coexistence path below is ready; Meta imposes a
24-hour synchronization window after onboarding.

The current test-number pipeline already works in production. Its profiles are
deployment-owned and stay authoritative. Existing app echoes are normalized to
`app_echo` and processed by the conversation-ownership path; this needs a genuine
coexistence pilot before real-number automation is enabled.

## Meta dashboard actions

The owner's dashboard shows business verification and integrity approved and app
review pending. Continue the existing review. Before production, confirm advanced
access to the required messaging and management permissions and Tech Provider
eligibility in that actual account. Linking the mobile number to Business Suite
does not complete Cloud API onboarding.

In Embedded Signup manager → Manage domains / authorized list, enable JavaScript
SDK login and authorize the frontend hosts used to launch the flow:

- `sophiaai.com.au`
- `www.sophiaai.com.au`
- `main.d9s1kjhti1xid.amplifyapp.com`

Use the exact HTTPS origins if the Meta field requests URLs instead of hostnames.
`https://nodejs-api-hft7.onrender.com` is the backend, not the signup page.
The supplied `http://localhost:4200` cannot be used where Meta requires HTTPS;
use the deployed frontend (or a separately approved HTTPS development origin).

## Deployment setup (not applied by this implementation)

Apply `134_whatsapp_signup_authorization.sql` through the normal owner migration
runner, preserving `sophia_runtime_app` and forced tenant RLS. Deploy backend and
frontend together. The owner-only Company → WhatsApp component fetches its public
SDK configuration from the authenticated backend; no Meta secret is built into
Angular. Missing configuration hides the signup action and preserves existing
receiving controls.

On **nodejs-api**, set:

```dotenv
WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false
WHATSAPP_META_APP_ID=1107965912211301
WHATSAPP_SIGNUP_CONFIG_ID=1141808901544273
WHATSAPP_GRAPH_VERSION=v26.0
WHATSAPP_SIGNUP_EXPECTED_PHONE=+61400388532
WHATSAPP_SIGNUP_CUSTOMER_ID=<server-verified-Sophia-AI-customer-UUID>
WHATSAPP_SIGNUP_ENCRYPTION_KEY=<dedicated-base64-encoded-32-byte-key>
```

Reuse the existing `WHATSAPP_SOPHIA_APP_SECRET` for this same Meta app only after
verifying the app binding. Keep signup disabled until synchronization and live
callback routing are ready. Do not put encryption keys, app secrets, authorization
codes or business tokens in chat, source control or browser storage.

## Protocol and storage

- Authenticated `GET /api/bm/lead-assistant/whatsapp-signup` returns availability,
  public SDK settings and an actor-scoped safe status.
- `POST .../start` creates a 15-minute actor/tenant-bound attempt with a hashed
  random nonce, invalidating that actor's previous attempt.
- `POST .../exchange` atomically consumes the attempt before exchanging the code.
  The callback is sent immediately, independently of Meta's session-event order.
- `POST .../complete` accepts only the Business App completion type. The server
  queries account membership and verifies the deployment-configured expected
  phone. Browser phone IDs and tenant claims are never trusted.
- Tokens use AES-256-GCM with customer/attempt associated data and a dedicated key.
  They are staged only, expire for use after 15 minutes, and are cleared on failed
  verification, the next authorized status refresh after expiry, or a new attempt.
  No background cleanup currently runs: stored ciphertext can remain until one of
  these actions. Approve a retention/cleanup policy before broader rollout.
- The encrypted staging row is not a channel credential store. No API exposes
  staged tokens. A later activation worker must consume them within their lifetime
  or the owner must authorize again.

## Remaining activation implementation and pilot

1. Durable subscription/synchronization orchestration, with callback routing ready
   before subscribing the real account; handle partial acceptance and uncertain
   outcomes without replaying one-shot operations blindly.
2. Subscribe to `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`,
   and `account_update` as required; verify the actual phone/account mapping.
3. Initiate contacts and history synchronization within Meta's deadline; persist
   bounded progress and completion evidence. Consent and retention must be explicit.
   Unsupported history/state events currently produce only unsupported receipts;
   this does not establish synchronized history or contacts.
4. Secure promotion into deployment-owned real-number profiles on API and worker
   (or a reviewed tenant-scoped credential resolver). Preserve the test profile;
   prevent overlapping channel ownership for the same phone.
5. Verify mobile-app human takeover and queued-reply cancellation, account
   disconnection/revocation handling, incoming messages and delivery status.
6. Enable automation only after the controlled real-number test; validate bookings
   and voice separately before enabling those capabilities.

## References

- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4
