# P6-A06C4 — recent-MFA identity gate

Date: 2026-10-04 (Australia/Brisbane)

Status: deployed operator proof passed; durable proof endpoint deployment remains pending.

## Implemented boundary

- Business Manager supports password-confirmed TOTP enrollment, code-confirmed
  activation and authenticated step-up.
- Enrollment presents a locally rendered QR code. The raw `otpauth://` payload
  is not displayed; a collapsed manual setup key remains available when a
  camera cannot scan the code.
- TOTP secrets are encrypted with AES-256-GCM using a deployment-owned key and
  the user identity as authenticated associated data. Plaintext is returned only
  in the no-store enrollment response and is never persisted.
- Six-digit codes accept a one-step clock window, are consumed monotonically to
  prevent replay, and lock activation or step-up verification for fifteen
  minutes after five failures.
- Successful MFA login or explicit API step-up issues a signed Business Manager
  token with the exact server timestamp. `/api/user` preserves that timestamp
  without refreshing it.
- Once a factor is active, password verification issues only a five-minute,
  purpose-bound login challenge. A replay-protected TOTP code must complete
  sign-in before an application token is issued, and that successful login
  establishes recent-MFA evidence for sensitive actions.
- Every protected Business Manager request resolves active-factor state from
  the database. An active factor requires a signed MFA timestamp no older than
  twelve hours; password-only pre-enrollment tokens and expired MFA sessions
  fail with HTTP 401. Ordinary activity never extends this absolute lifetime.
- Sophia Runtime accepts the signed timestamp through its existing identity
  bridge. Both the bridge and the Admin guard reject future timestamps; existing
  privileged permissions continue to require a timestamp no older than twelve
  hours.
- The Settings screen provides QR-first enrollment and activation. Activation
  ends the current session immediately. Every later sign-in requires password
  and authenticator code, and expiry returns the browser to full sign-in rather
  than presenting a separate routine step-up control.
- Self-service deactivation requires the current password plus a fresh,
  replay-protected authenticator code and an explicit warning acknowledgement.
  One transaction consumes the code, erases the factor secret, increments the
  user's signed session generation and appends an `mfa_disabled` security audit
  event. Every existing bearer token is then rejected, the browser signs out,
  and the account email receives an independent security notification.
- Password-only factor removal is not an account-recovery path. Lost-device
  recovery and organisation-enforced MFA remain separately governed work.

## Deployed proof

On 2026-10-04 the production database was verified to contain
`users.auth_session_version`, `user_mfa_factors` and
`user_security_audit_events`. The genuine operator enrolled TOTP, completed a
fresh MFA login and received a Business Manager identity containing the
server-issued `mfaVerifiedAt` timestamp.

The operator's existing Business Manager company was mapped to one new Sophia
tenant and the operator received the fixed `billing_administrator` role under
explicit user authority. The tenant was verified empty: it had no commercial
assignment, provider Customer, Checkout intent, subscription or invoice.

One bounded request with a synthetic plan identifier passed the deployed
`billing.manage` guard and stopped at the disabled live-Checkout boundary with
HTTP 503 before database billing work or Stripe I/O. An otherwise equivalent
signed identity without `mfaVerifiedAt` failed in Business Manager with HTTP
401 and `MFA_AUTHENTICATION_REQUIRED`; Runtime also returned HTTP 401. No
Customer, subscription, invoice, Checkout Session or charge was created.

The source now includes a dedicated `authorization-proof` action. It is guarded
by `billing.manage`, records only sanitized durable audit evidence, returns
`stripeRequest: false` and `liveCharge: false`, and invokes no billing provider.
Migration `055` stores that evidence in an append-only table accessible to the
runtime role only through narrow record/latest-proof functions. This allows the
global activation audit to consume the evidence for twelve hours without
bypassing tenant RLS or exposing tenant audit rows.

## Remaining deployment requirements

1. Invalidate and re-enroll any factor whose setup key or QR payload was copied
   outside the intended enrollment screen. A TOTP setup key is an
   authenticator secret, even though its six-digit outputs change.
2. Preserve the dedicated deployed `BM_MFA_ENCRYPTION_KEY`; do not reuse
   `JWT_SECRET`, a Stripe key or the Sophia connector secret.
3. Deploy the durable `authorization-proof` endpoint and repaired activation
   audit, then invoke the endpoint with a fresh MFA login before the final
   activation audit.

Checkout and both live collection switches remain disabled. This proof did not
contact Stripe or create a Customer, subscription, invoice, Checkout Session or
charge.
