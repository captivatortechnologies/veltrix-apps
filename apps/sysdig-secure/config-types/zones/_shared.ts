// Shared helpers for the Sysdig Secure Zones config type
// (validate + deploy + rollback + drift).
//
// Zone shape follows the Sysdig Secure /platform/v1/zones API (confirmed
// against terraform-provider-sysdig's v2 client, v1/rules-string form).
// Verify against a live Sysdig Secure.

import type { SysdigZone, SysdigZoneScope } from '../../lib/sysdigApi'

/** `targetType` values accepted by a zone scope. */
export const ZONE_TARGET_TYPES = new Set(['aws', 'gcp', 'azure', 'kubernetes', 'image', 'host', 'git', 'ibm', 'oci'])

export interface ZoneFields {
  name?: unknown
  description?: unknown
  enabled?: unknown
  scopesJson?: unknown
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return fallback
}

/** Parse `scopesJson` into scope objects. Malformed/non-array JSON yields none. */
export function parseScopes(value: unknown): SysdigZoneScope[] {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((entry) => ({
    targetType: String((entry as Record<string, unknown>)?.targetType ?? '').trim(),
    rules: String((entry as Record<string, unknown>)?.rules ?? '').trim(),
  }))
}

/** Whether `scopesJson` is present but fails to parse as a JSON array. */
export function isMalformedScopesJson(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  try {
    return !Array.isArray(JSON.parse(raw))
  } catch {
    return true
  }
}

/** Build the Sysdig zone body from canvas fields. */
export function buildZoneBody(fields: ZoneFields): SysdigZone {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    scopes: parseScopes(fields.scopesJson),
  }
}

/** Find a live zone by exact name among results already filtered server-side. */
export function findZoneByName(zones: SysdigZone[], name: string): SysdigZone | null {
  const n = name.trim()
  if (!n) return null
  return zones.find((z) => String(z.name ?? '').trim() === n) ?? null
}
