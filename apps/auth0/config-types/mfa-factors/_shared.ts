// Shared helpers for the Auth0 MFA (Guardian) config type (deploy + rollback +
// drift). Two tenant-wide sub-resources:
//   GET/PUT /api/v2/guardian/policies   bare JSON array (NOT wrapped in an
//                                        object): [] = never require MFA,
//                                        ["all-applications"] = always,
//                                        ["confidence-score"] = adaptive
//   GET     /api/v2/guardian/factors    all factors in one call:
//                                        [{ name, enabled, trialExpired? }, ...]
//   PUT     /api/v2/guardian/factors/{name}   { enabled: boolean }
//
// Verified against the official Auth0 Management API v2 (Guardian):
//   https://auth0.com/docs/api/management/v2/guardian

export const GUARDIAN_POLICIES_PATH = 'guardian/policies'
export const GUARDIAN_FACTORS_PATH = 'guardian/factors'

/** The tenant MFA enforcement policy values this config type authors. */
export const POLICY_VALUES = new Set(['never', 'all-applications', 'confidence-score'])

/**
 * Canvas checkbox field key → Auth0 Guardian factor name.
 *
 * NOTE: Auth0's docs and Terraform provider have begun consolidating SMS/voice
 * under a broader "phone" factor concept on some newer surfaces, but
 * `PUT /guardian/factors/{name}` with `sms` remains the long-documented,
 * stable factor name as of this writing — if Auth0 finalizes a rename this
 * app should be updated to match.
 */
export const FACTOR_FIELD_TO_NAME: Record<string, string> = {
  factor_sms: 'sms',
  factor_push_notification: 'push-notification',
  factor_otp: 'otp',
  factor_email: 'email',
  factor_duo: 'duo',
  factor_webauthn_roaming: 'webauthn-roaming',
  factor_webauthn_platform: 'webauthn-platform',
  factor_recovery_code: 'recovery-code',
}

/** One factor as returned by GET /guardian/factors. */
export interface Auth0GuardianFactor {
  name?: string
  enabled?: boolean
  trialExpired?: boolean
}

/** Convert the canvas policy select value to the array form PUT /guardian/policies expects. */
export function policyToArray(value: string): string[] {
  return value === 'never' ? [] : [value]
}

/** Convert the live array form back to the canvas policy select value. */
export function arrayToPolicy(arr: string[] | undefined): string {
  if (!arr || arr.length === 0) return 'never'
  return arr[0]
}

/** Read every factor checkbox field into an Auth0-factor-name → enabled map. */
export function readFactorFields(fields: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [fieldKey, factorName] of Object.entries(FACTOR_FIELD_TO_NAME)) {
    out[factorName] = fields[fieldKey] === true || fields[fieldKey] === 'true'
  }
  return out
}

/** Index a live factors list by factor name for lookups (unknown/extra live factors are ignored). */
export function indexFactors(list: Auth0GuardianFactor[]): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const f of list) {
    if (typeof f.name === 'string') out[f.name] = f.enabled === true
  }
  return out
}
