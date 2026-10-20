/**
 * Sendblue webhook check. Sendblue sends the configured signing secret itself in a
 * request header (`sb-signing-secret` by default); it is a shared secret, not an
 * HMAC. Compare in constant time and reject when no secret is configured.
 */
import { timingSafeEqual } from "node:crypto";

export const SENDBLUE_SECRET_HEADER = "sb-signing-secret";

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    const first = Array.isArray(v) ? v[0] : v;
    return first ?? "";
  }
  return "";
}

export function verifySendblueSecret(headers: Headers, secret: string | undefined, headerName = SENDBLUE_SECRET_HEADER): boolean {
  if (!secret) return false;
  const got = Buffer.from(header(headers, headerName));
  const want = Buffer.from(secret);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}
