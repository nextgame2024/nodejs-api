export const XERO_CONNECTOR_KEY = "xero-accounting";

export const XERO_READ_ONLY_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.settings.read",
  "accounting.invoices.read",
  "accounting.contacts.read",
] as const;

export const XERO_STUDENT_DISCOVERY_SCOPES = [
  "accounting.invoices.read",
  "accounting.contacts.read",
] as const;

export type XeroConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  returnUrl: string;
  stateSecret: string;
  encryptionKey: Buffer;
};

export function xeroConfiguration(): XeroConfig | null {
  const clientId = process.env.XERO_CLIENT_ID?.trim();
  const clientSecret = process.env.XERO_CLIENT_SECRET?.trim();
  const redirectUri = process.env.XERO_REDIRECT_URI?.trim();
  const returnUrl = process.env.XERO_RETURN_URL?.trim();
  const stateSecret = process.env.XERO_OAUTH_STATE_SECRET?.trim();
  const encodedKey = process.env.XERO_TOKEN_ENCRYPTION_KEY?.trim();
  if (!clientId || !clientSecret || !redirectUri || !returnUrl || !stateSecret || !encodedKey) {
    return null;
  }
  if (stateSecret.length < 32) throw new Error("XERO_OAUTH_STATE_SECRET must contain at least 32 characters.");
  const encryptionKey = Buffer.from(encodedKey, "base64");
  if (encryptionKey.length !== 32) {
    throw new Error("XERO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  requireHttpUrl(redirectUri, "XERO_REDIRECT_URI");
  requireHttpUrl(returnUrl, "XERO_RETURN_URL");
  return { clientId, clientSecret, redirectUri, returnUrl, stateSecret, encryptionKey };
}

function requireHttpUrl(value: string, name: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
    throw new Error(`${name} must use HTTPS, except for localhost development.`);
  }
}
