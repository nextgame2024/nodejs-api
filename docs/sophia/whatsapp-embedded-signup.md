# Sophia AI real-number onboarding

Updated 20 November 2026. Scope: Sophia AI's own +61 400 388 532,
not Open for Australia. Meta app `1107965912211301`; owner-confirmed Embedded
Signup configuration `1141808901544273` includes WhatsApp Cloud API.

## Connection flow

Company → WhatsApp → Prepare connection → Continue with Meta launches the existing
WhatsApp Business app onboarding flow. The owner selects SophiaAi and authorizes
its existing number on their phone. The server verifies the expected number and
Meta's `is_on_biz_app=true` / `platform_type=CLOUD_API` evidence.

Authorization is tenant/actor-bound, nonce-protected, one-use and expires after
15 minutes. Tokens are encrypted with AES-256-GCM and tenant-specific associated
data. Successful verification promotes the token into the tenant-scoped
`whatsapp_connections` table and clears temporary authorization ciphertext.

The API workflow durably claims subscription, contacts synchronization and history
synchronization operations. The real callback is routable before subscription.
Only successful responses advance the operation. Timeouts, invalid responses and
stale in-flight claims require administrator reconciliation; one-shot sync calls
are never blindly replayed. Meta request IDs are retained. A 24-hour deadline is
tracked. A verified subscription uses the real channel's callback override.

Signed history and contact callbacks enter an encrypted, deduplicated receipt
queue. A worker imports up to 500 records per transaction with a durable cursor.
Imported history never opens a reply window, transcribes old audio or queues AI
replies. Up to 500 recent archived messages are attached to an existing/new
contact's timeline without replaying inbound automation. Raw synchronization
receipts expire after seven days. History sharing declined in Meta is respected.
A final history progress of 100 or an explicit sharing decline marks the
connection ready once both synchronization requests were accepted.

The real-number profile inherits the deployment-approved Sophia reasoning and
speech configuration; its token and account/phone mapping come from the encrypted
connection record. Existing test profile mappings are preserved. Runtime reads
and writes use `sophia_runtime_app` and forced tenant RLS. Workers refresh profiles
while running so activation requires no credential copy or deploy.

The new channel starts with the existing approved agent release in **review**
mode. Validate receiving and a staff reply, then use Company → WhatsApp → Configure
Sophia replies to enable automatic responses. A signed PARTNER_REMOVED or
ACCOUNT_OFFBOARDED callback immediately disables receiving/sending and clears the
persisted credential. Mobile-app echo messages use the existing human-takeover
path and invalidate queued automatic replies. Reauthorization is supported after
a confirmed disconnection; an uncertain activation is held for investigation.

## Deployment

Apply owner migrations `134_whatsapp_signup_authorization.sql` and
`137_whatsapp_coexistence.sql`. On the API and worker configure:

```dotenv
WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true
WHATSAPP_COEXISTENCE_ACTIVATION_ENABLED=true
WHATSAPP_META_APP_ID=1107965912211301
WHATSAPP_SIGNUP_CONFIG_ID=1141808901544273
WHATSAPP_GRAPH_VERSION=v26.0
WHATSAPP_SIGNUP_EXPECTED_PHONE=+61400388532
WHATSAPP_SIGNUP_CUSTOMER_ID=7a29fe5c-65ab-495c-90de-69727cea7358
WHATSAPP_SIGNUP_BASE_PROFILE=sophia_ai
WHATSAPP_SIGNUP_API_ORIGIN=https://nodejs-api-hft7.onrender.com
WHATSAPP_SIGNUP_ENCRYPTION_KEY=<dedicated-base64-encoded-32-byte-key>
```

Reuse the existing app secret and verification token for this Meta app. Keep
secrets out of Angular, logs and source control. Enable signup only after the
callback deployment and app subscription checks pass. The app-level subscription
must include `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync` and
`account_update`. Preserve the current test-number callback and existing fields;
account lifecycle events always use the app-level callback. Per-account overrides
route the real number's messages and sync callbacks separately.

The frontend domains must be authorized for the Meta JavaScript SDK. Launch
signup from the deployed HTTPS frontend; ordinary HTTP localhost is not a
substitute for an approved HTTPS origin. Frontend status UI changes remain local
until the owner commits/pushes them.

## Remaining live validation

The owner must complete Meta authorization. Verify the real account/phone IDs,
request IDs and sync completion, text receiving/reply, mobile-app takeover,
automatic replies, booking and voice on the real number. App permissions and
coexistence eligibility remain Meta-enforced. The owner confirmed the signup
product configuration; this is not evidence of Advanced Access approval.

If an operation is uncertain, inspect request IDs, signed callbacks and Meta
subscription status before changing a checkpoint. Do not repeat contacts/history
requests without evidence that they were rejected before acceptance. Do not
reregister or deregister the existing Business app number through the ordinary
Cloud API registration flow.

## References

- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4

## Owner pilot result — 20 November 2026

Meta rejected the first real-number signup attempt with error `3441107`:
"This partner's app isn't set up yet to connect WhatsApp Business app numbers."
The deployed public bundle was inspected and sends the documented
`featureType: whatsapp_business_app_onboarding`. The signup row stayed `started`;
Meta returned no authorization and no real connection was created. Do not confuse
own-business Cloud API access with coexistence eligibility. The owner must check
Tech Provider onboarding and App Review/Advanced Access status. Meta's Tech
Provider guide permits the existing test number/API Setup to demonstrate sending
and WhatsApp Manager to demonstrate template creation for review.
