// Shared helpers for the Auth0 Attack Protection config type (deploy + rollback
// + drift). Attack Protection covers three independent, always-existing
// tenant-wide sub-resources — GET/PATCH only, no create/delete:
//   GET/PATCH /api/v2/attack-protection/breached-password-detection
//   GET/PATCH /api/v2/attack-protection/brute-force-protection
//   GET/PATCH /api/v2/attack-protection/suspicious-ip-throttling
//
// Each sub-resource is authored as free-form JSON matching the exact
// documented Auth0 request body. A blank field means "leave this sub-resource
// untouched" — never "disable/clear it" — because this singleton can be
// combined on a canvas with other tenant-wide config types and must never
// clobber a setting it wasn't asked to manage.
//
// Verified against the official Auth0 Management API v2 (Attack Protection):
//   https://auth0.com/docs/api/management/v2/attack-protection

import { parseJsonObject, readOptionalString } from '../../lib/fields'

export const BREACHED_PASSWORD_DETECTION_PATH = 'attack-protection/breached-password-detection'
export const BRUTE_FORCE_PROTECTION_PATH = 'attack-protection/brute-force-protection'
export const SUSPICIOUS_IP_THROTTLING_PATH = 'attack-protection/suspicious-ip-throttling'

/** Breached Password Detection request/response body. */
export interface BreachedPasswordDetection {
  enabled?: boolean
  shields?: string[]
  admin_notification_frequency?: string[]
  method?: 'standard' | 'enhanced'
  pre_user_registration?: { shields: string[] }
  pre_change_password?: { shields: string[] }
  [key: string]: unknown
}

/** Brute-force Protection request/response body. */
export interface BruteForceProtection {
  enabled?: boolean
  shields?: string[]
  allowlist?: string[]
  mode?: 'count_per_identifier_and_ip' | 'count_per_identifier'
  max_attempts?: number
  [key: string]: unknown
}

/** Suspicious IP Throttling request/response body. */
export interface SuspiciousIpThrottling {
  enabled?: boolean
  shields?: string[]
  allowlist?: string[]
  pre_login?: { max_attempts: number; rate: number }
  pre_user_registration?: { max_attempts: number; rate: number }
  [key: string]: unknown
}

export interface DeclaredObjectField {
  /** False when the canvas field was left blank — the sub-resource should not be touched. */
  declared: boolean
  value: Record<string, unknown>
}

/**
 * Read one of the three sub-resource JSON fields. A blank field yields
 * `{ declared: false }` so callers know to skip the sub-resource entirely.
 * Malformed JSON (already rejected by validate.ts) falls back to `{}` rather
 * than throwing, matching this app's other free-form JSON fields (e.g.
 * connections' `options`).
 */
export function declaredObjectField(value: unknown): DeclaredObjectField {
  if (readOptionalString(value) === undefined) return { declared: false, value: {} }
  const parsed = parseJsonObject(value)
  return { declared: true, value: parsed.ok ? parsed.value : {} }
}
