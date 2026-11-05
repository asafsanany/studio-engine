// The `sub` claim of the VAPID token (RFC 8292): who runs this server, so a push service can write
// to them before it blocks. A `mailto:` address or an https URL. It comes from config.json
// (`pushSubject`) or is the Mac owner's Tailscale login, which is an email address.

/** Used when neither the config nor Tailscale gave one. */
export const FALLBACK_VAPID_SUBJECT = 'mailto:studio-engine@localhost';

const EMAIL = /^[^\s@:]+@[^\s@]+$/;
const HTTPS_URL = /^https:\/\/\S+$/;

/** `value` as a VAPID subject: an email gets `mailto:`, an https URL or a `mailto:` stays; else `null`. */
export function vapidSubjectOf(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (text === '') return null;
  if (HTTPS_URL.test(text)) return text;
  const address = text.replace(/^mailto:/i, '');
  return EMAIL.test(address) ? `mailto:${address}` : null;
}

/** The subject to sign with: the configured one, else the Mac owner's login, else a placeholder. */
export function resolveVapidSubject(
  configured: string | undefined,
  ownerLogin: string | undefined,
): string {
  return vapidSubjectOf(configured) ?? vapidSubjectOf(ownerLogin) ?? FALLBACK_VAPID_SUBJECT;
}
