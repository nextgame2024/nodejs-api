# P6-A06C4 — recent-MFA identity gate

Date: 2026-10-04 (Australia/Brisbane)

Status: implemented; deployment configuration and authenticated operator proof remain required.

## Implemented boundary

- Business Manager supports password-confirmed TOTP enrollment, code-confirmed
  activation and authenticated step-up.
- TOTP secrets are encrypted with AES-256-GCM using a deployment-owned key and
  the user identity as authenticated associated data. Plaintext is returned only
  in the no-store enrollment response and is never persisted.
- Six-digit codes accept a one-step clock window, are consumed monotonically to
  prevent replay, and lock activation or step-up verification for fifteen
  minutes after five failures.
- Successful step-up issues a signed Business Manager token with the exact
  server timestamp. `/api/user` preserves that timestamp without refreshing it.
- Sophia Runtime accepts the signed timestamp through its existing identity
  bridge. Both the bridge and the Admin guard reject future timestamps; existing
  privileged permissions continue to require a timestamp no older than twelve
  hours.
- The Settings screen provides enrollment, activation and step-up controls. It
  replaces the stored bearer token only after authoritative step-up success.

## Deployment requirements

1. Apply `scripts/sql/user_mfa_factors.sql` to the Business Manager database
   using its authorised owner connection.
2. Generate a dedicated 32-byte base64 key and install it only in the Business
   Manager Render service as `BM_MFA_ENCRYPTION_KEY`. Do not reuse `JWT_SECRET`,
   a Stripe key or the Sophia connector secret.
3. Optionally set `BM_MFA_TOTP_ISSUER`; the default label is `Sophia AI`.
4. Deploy backend and frontend, then enroll the genuine operator from Settings.
5. Prove that step-up refreshes `/api/user.mfaVerifiedAt` and that a protected
   Sophia `billing.manage` request passes while the same request without recent
   evidence fails closed.

Checkout and both live collection switches remain disabled. This checkpoint did
not apply the schema, enroll a factor, issue a production MFA token, contact
Stripe, or create a charge.
