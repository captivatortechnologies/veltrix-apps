// Shared helpers for the Sysdig Secure Teams config type
// (validate + deploy + rollback + drift).
//
// Team shape follows the Sysdig Secure /api/teams API (confirmed against
// terraform-provider-sysdig's v2 client). Verify against a live Sysdig Secure.

import type { SysdigTeam, SysdigUserRole } from '../../lib/sysdigApi'

/** Roles a `userRolesJson` entry may declare, plus a numeric custom-role id. */
export const BUILTIN_TEAM_ROLES = new Set(['ROLE_TEAM_STANDARD', 'ROLE_TEAM_EDIT', 'ROLE_TEAM_READ', 'ROLE_TEAM_MANAGER'])

export interface TeamFields {
  name?: unknown
  description?: unknown
  theme?: unknown
  enabled?: unknown
  scopeBy?: unknown
  filter?: unknown
  useSysdigCapture?: unknown
  canUseAgentCli?: unknown
  canUseRapidResponse?: unknown
  defaultTeam?: unknown
  allZones?: unknown
  zoneNames?: unknown
  userRolesJson?: unknown
}

/** One entry parsed from the `userRolesJson` textarea. */
export interface UserRoleSpec {
  email: string
  role: string
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return fallback
}

export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** Parse `userRolesJson` into `{email, role}` entries. Malformed JSON yields none. */
export function parseUserRoles(value: unknown): UserRoleSpec[] {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((entry) => ({
      email: String((entry as Record<string, unknown>)?.email ?? '').trim(),
      role: String((entry as Record<string, unknown>)?.role ?? 'ROLE_TEAM_STANDARD').trim(),
    }))
    .filter((r) => r.email)
}

/** Whether `userRolesJson` is present but fails to parse as a JSON array. */
export function isMalformedUserRolesJson(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  try {
    return !Array.isArray(JSON.parse(raw))
  } catch {
    return true
  }
}

/**
 * Build the Sysdig team body from canvas fields. `zoneIds` and `userRoles` are
 * resolved separately (async, against live Sysdig data) and passed in.
 */
export function buildTeamBody(fields: TeamFields, zoneIds: number[], userRoles: SysdigUserRole[]): SysdigTeam {
  const allZones = normalizeBoolean(fields.allZones, false)
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    theme: String(fields.theme ?? '#73A1F7').trim(),
    scopeBy: String(fields.scopeBy ?? 'container').trim(),
    filter: String(fields.filter ?? '').trim() || undefined,
    useSysdigCapture: normalizeBoolean(fields.useSysdigCapture, true),
    canUseAgentCli: normalizeBoolean(fields.canUseAgentCli, true),
    canUseRapidResponse: normalizeBoolean(fields.canUseRapidResponse, false),
    default: normalizeBoolean(fields.defaultTeam, false),
    allZones,
    zoneIds: allZones ? undefined : zoneIds,
    origin: 'SYSDIG',
    userRoles,
  }
}

/** Find a live team by exact name. */
export function findTeamByName(teams: SysdigTeam[], name: string): SysdigTeam | null {
  const n = name.trim()
  if (!n) return null
  return teams.find((t) => String(t.name ?? '').trim() === n) ?? null
}
