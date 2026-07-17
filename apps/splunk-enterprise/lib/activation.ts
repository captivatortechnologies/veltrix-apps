// =============================================================================
// activation — the one-time credential-handoff core (pure, DB-free, testable).
//
// Flow: env reaches "ready" → mint a single-use token (≤24h) → email the
// initiating admin a LINK (never a password) → admin sets their own password →
// it is relayed to Splunk → token consumed. Only the SHA-256 of the token is
// ever persisted; the token itself lives only in the emailed link.
//
// Anchored to NIST SP 800-63A (single-use, ≤24h out-of-band secret) and 800-63B
// (15-char subscriber-chosen floor) + OWASP (never email a password).
// =============================================================================

import { randomBytes, createHash } from 'node:crypto'

/** Activation link validity — NIST 800-63A caps a validated-email out-of-band
 *  secret at 24h. */
export const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000

/** NIST 800-63B: subscriber-chosen secrets SHALL permit ≥ 15 characters. */
export const MIN_PASSWORD_LENGTH = 15

/** A freshly minted token: the raw value (goes in the link only) + its hash
 *  (the only thing stored). */
export interface MintedToken {
  /** URL-safe raw token — emailed in the link, NEVER stored. */
  token: string
  /** SHA-256 hex of the token — stored + looked up. */
  tokenHash: string
}

/** Generate a single-use activation token. 32 random bytes → ~43-char base64url;
 *  the stored form is the SHA-256 so a DB read never reveals a usable token. */
export function mintToken(): MintedToken {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashToken(token) }
}

/** SHA-256 hex of a token — the stored/lookup form. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Expiry timestamp for a token minted at `now` (ms epoch → ISO). */
export function expiryFrom(nowMs: number): string {
  return new Date(nowMs + ACTIVATION_TTL_MS).toISOString()
}

/** The shape a validity check needs (subset of the stored row). */
export interface TokenState {
  status: string
  expires_at: string | Date
}

/** A token is usable iff it is still pending and not past its expiry. */
export function isTokenUsable(row: TokenState | null | undefined, nowMs: number): boolean {
  if (!row) return false
  if (row.status !== 'pending') return false
  const exp = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at))
  return Number.isFinite(exp) && exp > nowMs
}

export interface PasswordCheck {
  ok: boolean
  message: string
}

/** Enforce the NIST-aligned admin password policy. Length is the primary lever
 *  (NIST deprecates composition rules); we also reject the removed Splunk
 *  defaults and all-whitespace. */
export function checkPasswordPolicy(password: string): PasswordCheck {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }
  }
  if (password.length > 256) {
    return { ok: false, message: 'Password must be at most 256 characters.' }
  }
  if (password.trim().length === 0) {
    return { ok: false, message: 'Password must not be only whitespace.' }
  }
  if (['changeme', 'admin', 'password'].includes(password.toLowerCase())) {
    return { ok: false, message: 'Password is too common.' }
  }
  return { ok: true, message: 'ok' }
}

/** Build the activation link the admin clicks. `baseUrl` is the platform console
 *  origin (e.g. https://app.veltrixsecops.com); the page reads `token` from the
 *  query and calls the app's activation routes. */
export function buildActivationLink(baseUrl: string, token: string): string {
  const origin = baseUrl.replace(/\/+$/, '')
  return `${origin}/apps/splunk-enterprise/activate?token=${encodeURIComponent(token)}`
}

export interface ActivationEmail {
  subject: string
  text: string
  html: string
}

/** Compose the activation email. It carries only a single-use LINK — never a
 *  password. Written to the outbox for the platform notification worker. */
export function buildActivationEmail(opts: {
  environmentName: string
  adminUser: string
  link: string
  expiresAtIso: string
}): ActivationEmail {
  const { environmentName, adminUser, link, expiresAtIso } = opts
  const expires = new Date(expiresAtIso).toUTCString()
  const subject = `Activate your Splunk environment "${environmentName}"`
  const text = [
    `Your Splunk environment "${environmentName}" is ready.`,
    ``,
    `Set the administrator (${adminUser}) password using this single-use link:`,
    link,
    ``,
    `The link can be used once and expires ${expires}.`,
    `If you did not request this, ignore this email — no password has been set.`,
  ].join('\n')
  const html = [
    `<p>Your Splunk environment <strong>${escapeHtml(environmentName)}</strong> is ready.</p>`,
    `<p>Set the administrator (<code>${escapeHtml(adminUser)}</code>) password using this single-use link:</p>`,
    `<p><a href="${escapeHtml(link)}">Set your admin password</a></p>`,
    `<p>The link can be used once and expires <strong>${escapeHtml(expires)}</strong>.</p>`,
    `<p>If you did not request this, ignore this email — no password has been set.</p>`,
  ].join('\n')
  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
