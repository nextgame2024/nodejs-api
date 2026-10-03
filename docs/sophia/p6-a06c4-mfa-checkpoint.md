# P6-A06C4 — recent-MFA identity gate

Date: 2026-10-04 (Australia/Brisbane)

Status: implemented; deployment configuration and authenticated operator proof remain required.

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

## Deployment requirements

1. Invalidate and re-enroll any factor whose setup key or QR payload was copied
   outside the intended enrollment screen. A TOTP setup key is an
   authenticator secret, even though its six-digit outputs change.
2. Apply `scripts/sql/user_mfa_factors.sql` to the Business Manager database
   using its authorised owner connection. Existing deployments must rerun the
   additive script for `auth_session_version` and the security-audit table, or
   allow the normal startup schema synchronisation to apply them.
3. Generate a dedicated 32-byte base64 key and install it only in the Business
   Manager Render service as `BM_MFA_ENCRYPTION_KEY`. Do not reuse `JWT_SECRET`,
   a Stripe key or the Sophia connector secret.
4. Optionally set `BM_MFA_TOTP_ISSUER`; the default label is `Sophia AI`.
5. Deploy backend and frontend, then enroll the genuine operator from Settings.
6. Prove that MFA login supplies `/api/user.mfaVerifiedAt` and that a protected
   Sophia `billing.manage` request passes while the same request without recent
   evidence fails closed.

Checkout and both live collection switches remain disabled. This checkpoint did
not apply the schema, enroll a factor, issue a production MFA token, contact
Stripe, or create a charge.
