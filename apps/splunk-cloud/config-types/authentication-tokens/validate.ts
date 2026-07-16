import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Splunk Cloud token-authentication SETTINGS — validation + the spec extraction
// shared by deploy / rollback / healthCheck / driftDetect.
//
// SCOPE — SETTINGS, NOT SECRETS. This configuration type manages the stack's
// token-authentication FEATURE SETTINGS, never the JWT token VALUES themselves
// (those are secrets). The two configurable settings are:
//   1. tokenAuthEnabled — whether token authentication is turned on for the stack
//   2. defaultExpiration — the default lifetime applied to newly-issued tokens
//
// These are NOT an ACS resource. The ACS API exposes only per-token CRUD
// (GET/POST /adminconfig/v2/tokens — which issue/return SECRET token values and
// are therefore out of scope here). The token-auth SETTINGS live on the Splunk
// Cloud Platform REST API, exactly like this app's `roles` type:
//
//   GET  /services/admin/token-auth/tokens_auth   → current settings
//   POST /services/admin/token-auth/tokens_auth   → update settings
//        params: disabled=<true|false>, expiration=<relative-time, e.g. +30d>
//
// on the stack's management port 8089. See lib/splunkRest.ts for the two
// prerequisites (Support must open 8089; the caller's IP must be on the
// `search-api` allow list — managed by this app's `ip-allowlists` type).
//
// Canvas field  ⇄  REST parameter (authorize.conf [tokens_auth] stanza)
//   tokenAuthEnabled  ⇄  disabled   (inverted: disabled = NOT enabled)
//   defaultExpiration ⇄  expiration (a Splunk relative-time modifier)
//
// Docs:
//  - Enable/disable token authentication (endpoint + `disabled`/`expiration`):
//    https://help.splunk.com/en/splunk-cloud-platform/administer/manage-users-and-security/9.3.2411/authenticate-into-the-splunk-platform-with-tokens/enable-or-disable-token-authentication
//  - ACS "Manage authentication tokens" (per-token CRUD only — secrets, hence
//    out of scope): https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.3.2512/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/manage-authentication-tokens-in-splunk-cloud-platform
// =============================================================================

/**
 * Splunk relative-time modifier used by the `expiration` setting, e.g. `+30d`,
 * `+12h`, `+6h`, `+90d`, `+1y`. Units follow Splunk's relative-time syntax
 * (seconds, minutes, hours, days, weeks, months, years). `mon` is matched before
 * `m` so a month is not read as a minute.
 */
export const RELATIVE_EXPIRATION_RE = /^\+(\d+)(mon|s|m|h|d|w|y)$/

/** Approximate days per relative-time unit (for the long-lived-token warning). */
const DAYS_PER_UNIT: Record<string, number> = {
  s: 1 / 86400,
  m: 1 / 1440,
  h: 1 / 24,
  d: 1,
  w: 7,
  mon: 30,
  y: 365,
}

/** Warn when the default token lifetime exceeds this many days (long-lived tokens). */
export const LONG_EXPIRATION_DAYS = 365

/** True when a string is a valid Splunk relative-time expiration modifier. */
export function isValidExpiration(value: string): boolean {
  return RELATIVE_EXPIRATION_RE.test(value.trim())
}

/** Approximate number of days a relative-time expiration represents, or null. */
export function expirationDays(value: string): number | null {
  const match = RELATIVE_EXPIRATION_RE.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * DAYS_PER_UNIT[match[2]]
}

/**
 * Coerce a canvas checkbox value to a boolean.
 *   - `undefined` → the field is absent/blank
 *   - `null`      → the field is present but not a boolean (invalid)
 *   - boolean     → the coerced value
 * Checkboxes send real booleans; the string forms are accepted defensively.
 */
export function coerceBool(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return null
}

/** Shape of GET /services/admin/token-auth/tokens_auth → entry[0].content. */
export interface LiveTokenAuthSettings {
  /** `disabled` is returned as a boolean or a "0"/"1"/"true"/"false" string. */
  disabled?: boolean | number | string
  /** Default token expiration, a relative-time modifier such as "+30d". */
  expiration?: string
}

/** True when token authentication is enabled live (i.e. NOT disabled). */
export function isTokenAuthEnabled(content: Record<string, unknown> | null): boolean {
  const raw = content?.disabled
  const disabled = raw === true || raw === 1 || raw === '1' || raw === 'true'
  return !disabled
}

/** The live default expiration setting, or undefined when the stack has none set. */
export function readLiveExpiration(content: Record<string, unknown> | null): string | undefined {
  const raw = content?.expiration
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/** Normalize any live `disabled` value to the "true"/"false" string the REST API accepts. */
export function normalizeDisabledParam(value: unknown): 'true' | 'false' {
  return value === true || value === 1 || value === '1' || value === 'true' ? 'true' : 'false'
}

// --- Spec extraction ---------------------------------------------------------

export interface TokenSettingsSpec {
  sectionName: string
  /** Present only when a valid boolean was supplied; validate() reports the rest. */
  tokenAuthEnabled: boolean | undefined
  /** Trimmed relative-time modifier, or undefined when left blank. */
  defaultExpiration: string | undefined
}

/**
 * Extract the single token-auth settings object from the canvas. This is a
 * SINGLE-object configuration (canvas.yaml pins the item to exactly one), so the
 * spec comes from the first item; extra items are flagged by validate().
 */
export function extractTokenSettingsSpec(canvas: CanvasSnapshot): TokenSettingsSpec | null {
  const section = (canvas.sections ?? [])[0]
  if (!section) return null
  const fields = section.fields ?? {}

  const coerced = coerceBool(fields.tokenAuthEnabled)
  const rawExpiration = fields.defaultExpiration

  return {
    sectionName: section.name,
    tokenAuthEnabled: typeof coerced === 'boolean' ? coerced : undefined,
    defaultExpiration:
      typeof rawExpiration === 'string' && rawExpiration.trim() ? rawExpiration.trim() : undefined,
  }
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate the stack's token-authentication settings:
 *   - exactly one settings object (single-object configuration)
 *   - tokenAuthEnabled is an explicit boolean
 *   - defaultExpiration, when supplied, is a Splunk relative-time modifier
 * plus safety warnings for disabling token auth and for very long-lived tokens.
 *
 * Never touches the network — the REST prerequisites (port 8089 open; caller IP
 * on the `search-api` allow list) are surfaced at deploy/health-check time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({
      field: 'sections',
      message: 'Canvas has no token-authentication settings object',
      code: 'empty_canvas',
    })
    return { valid: false, errors, warnings }
  }

  // Single-object configuration: token-auth settings are stack-wide, so there is
  // exactly one settings object — never a list.
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: `Token authentication has a single stack-wide settings object, but ${sections.length} were provided`,
      code: 'single_object',
    })
  }

  const section = sections[0]
  const fields = section.fields || {}
  const prefix = section.name

  // --- tokenAuthEnabled -------------------------------------------------------
  const enabled = coerceBool(fields.tokenAuthEnabled)
  if (enabled === undefined) {
    errors.push({
      field: `${prefix}.tokenAuthEnabled`,
      message: 'Token Authentication Enabled is required (true or false)',
      code: 'required',
    })
  } else if (enabled === null) {
    errors.push({
      field: `${prefix}.tokenAuthEnabled`,
      message: 'Token Authentication Enabled must be a boolean (true or false)',
      code: 'invalid_enabled',
    })
  } else if (enabled === false) {
    // Disabling token auth immediately invalidates EVERY existing token on the
    // stack — valid, but a change worth flagging.
    warnings.push({
      field: `${prefix}.tokenAuthEnabled`,
      message:
        'Disabling token authentication makes all existing tokens on the stack immediately unusable until it is re-enabled',
      code: 'token_auth_disabled',
    })
  }

  // --- defaultExpiration ------------------------------------------------------
  const rawExpiration = fields.defaultExpiration
  if (rawExpiration !== undefined && rawExpiration !== null && String(rawExpiration).trim() !== '') {
    const expiration = String(rawExpiration).trim()
    if (!isValidExpiration(expiration)) {
      errors.push({
        field: `${prefix}.defaultExpiration`,
        message: `"${expiration}" is not a valid Splunk relative-time expiration — use a modifier like +30d, +12h or +90d`,
        code: 'invalid_expiration',
      })
    } else {
      const days = expirationDays(expiration)
      if (days !== null && days > LONG_EXPIRATION_DAYS) {
        warnings.push({
          field: `${prefix}.defaultExpiration`,
          message: `A default expiration of "${expiration}" issues very long-lived tokens (> ${LONG_EXPIRATION_DAYS} days) — prefer a shorter default and rotate`,
          code: 'long_expiration',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
