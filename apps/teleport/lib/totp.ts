// =============================================================================
// RFC 6238 TOTP (and its RFC 4226 HOTP base) — implemented against Node's
// built-in `node:crypto` only. No external OTP dependency is bundled; the
// platform only guarantees @veltrixsecops/app-sdk at runtime, and every value
// this needs (a base32 shared secret, the current time) is already available
// in-process.
//
// Why this exists: the Teleport Proxy web API (see ../lib/teleport.ts) logs in
// with `{user, pass, second_factor_token}` exactly like the Web UI's own login
// form. When the connecting local user has a TOTP device enrolled (the only
// second factor a headless client can satisfy — WebAuthn requires a physical
// authenticator/browser), this computes that 6-digit code from the enrolled
// device's base32 seed at request time.
// =============================================================================

import { createHmac } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode a base32 (RFC 4648, no padding required) string to raw bytes. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = ''
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char)
    if (value === -1) continue
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

/**
 * RFC 4226 HOTP: an HMAC-SHA1-based one-time password over a 64-bit counter.
 * Verified against the RFC 4226 Appendix D test vectors (secret = ASCII
 * "12345678901234567890", digits=6): counter 0 -> "755224", counter 1 ->
 * "287082" (see __tests__/totp.test.ts).
 */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const counterBuffer = Buffer.alloc(8)
  // A TOTP counter (unix-seconds / period) stays far below 2^32 for any
  // realistic clock, so the high 32 bits are always zero in practice.
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  counterBuffer.writeUInt32BE(counter >>> 0, 4)

  const hmac = createHmac('sha1', key).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  return (binary % 10 ** digits).toString().padStart(digits, '0')
}

export interface TotpOptions {
  /** Code validity window in seconds. Teleport (like virtually all TOTP consumers) uses 30. */
  period?: number
  digits?: number
  /** Override "now" for deterministic tests. */
  timestampMs?: number
}

/** Compute the current RFC 6238 TOTP code for a base32-encoded shared secret. */
export function generateTotp(base32Secret: string, opts: TotpOptions = {}): string {
  const period = opts.period ?? 30
  const digits = opts.digits ?? 6
  const timestampMs = opts.timestampMs ?? Date.now()
  const counter = Math.floor(Math.floor(timestampMs / 1000) / period)
  const key = base32Decode(base32Secret)
  return hotp(key, counter, digits)
}
