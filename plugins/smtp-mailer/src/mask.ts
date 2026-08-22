/**
 * Mask a recipient address for logging — the logging discipline (doc §6) allows
 * logging the recipient, but masking it keeps PII out of logs by default.
 *
 * `alice@example.com` → `a***e@example.com`; a short local part → `***@domain`.
 * A value with no `@` is treated as opaque and fully masked.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  // No local part, or no domain (`alice@`) → fully opaque; never reveal chars of
  // a malformed address.
  if (at <= 0 || at === address.length - 1) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length <= 2) return `***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}
